-- ============================================================
-- TT AMBASSADOR PORTAL — Initial schema
-- Run via: supabase db push  (or paste into Supabase SQL editor)
-- ============================================================

create extension if not exists "pgcrypto";
create extension if not exists "moddatetime" schema extensions;

-- ------------------------------------------------------------
-- ENUM TYPES
-- ------------------------------------------------------------
create type user_role as enum ('admin', 'ambassador');
create type ambassador_status as enum ('active', 'suspended', 'deactivated');
create type sale_status as enum ('pending', 'approved', 'cancelled', 'rejected');
create type payout_status as enum ('submitted', 'under_review', 'approved', 'paid', 'rejected', 'cancelled');
create type application_status as enum ('pending', 'approved', 'rejected');

-- ------------------------------------------------------------
-- PROFILES  (extends Supabase auth.users — never store passwords here)
-- ------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  role user_role not null default 'ambassador',
  first_name text not null,
  last_name text not null,
  email text not null,
  phone text,
  instagram text,
  tiktok text,
  revolut_identifier text,
  commission_rate numeric(5,2) not null default 5.00 check (commission_rate >= 0 and commission_rate <= 100),
  status ambassador_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index profiles_email_idx on public.profiles (lower(email));

-- ------------------------------------------------------------
-- SALES  (admin-entered only)
-- ------------------------------------------------------------
create table public.sales (
  id uuid primary key default gen_random_uuid(),
  ambassador_id uuid not null references public.profiles(id) on delete restrict,
  order_number text not null,
  sale_date date not null default current_date,
  sale_value numeric(10,2) not null check (sale_value > 0),
  commission_rate numeric(5,2) not null,           -- snapshot at time of sale, never recalculated retroactively
  commission_amount numeric(10,2) not null,          -- sale_value * commission_rate / 100, snapshot
  status sale_status not null default 'pending',
  note text,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index sales_ambassador_idx on public.sales (ambassador_id);

-- Snapshot the commission rate + amount automatically at insert time
create or replace function public.compute_sale_commission()
returns trigger language plpgsql as $$
begin
  if new.commission_rate is null then
    select commission_rate into new.commission_rate from public.profiles where id = new.ambassador_id;
  end if;
  new.commission_amount := round(new.sale_value * new.commission_rate / 100.0, 2);
  return new;
end;
$$;

create trigger trg_sales_commission
before insert on public.sales
for each row execute function public.compute_sale_commission();

create trigger trg_sales_updated_at
before update on public.sales
for each row execute function extensions.moddatetime('updated_at');

-- ------------------------------------------------------------
-- PAYOUT REQUESTS
-- ------------------------------------------------------------
create table public.payout_requests (
  id uuid primary key default gen_random_uuid(),
  request_number text not null unique,               -- e.g. PAYOUT-00124
  ambassador_id uuid not null references public.profiles(id) on delete restrict,
  first_name text not null,
  last_name text not null,
  revolut_identifier text not null,
  amount numeric(10,2) not null check (amount > 0),
  status payout_status not null default 'submitted',
  editable_until timestamptz not null default (now() + interval '60 minutes'),
  admin_note text,
  payment_reference text,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index payout_ambassador_idx on public.payout_requests (ambassador_id);

create sequence if not exists public.payout_number_seq start 100;
create or replace function public.set_payout_number()
returns trigger language plpgsql as $$
begin
  if new.request_number is null then
    new.request_number := 'PAYOUT-' || lpad(nextval('public.payout_number_seq')::text, 5, '0');
  end if;
  return new;
end;
$$;

create trigger trg_payout_number
before insert on public.payout_requests
for each row execute function public.set_payout_number();

create trigger trg_payout_updated_at
before update on public.payout_requests
for each row execute function extensions.moddatetime('updated_at');

-- Available balance = approved sales commission - (paid + submitted/under_review/approved payout requests)
create or replace function public.get_available_balance(p_ambassador_id uuid)
returns numeric language sql stable as $$
  select coalesce((
    select sum(commission_amount) from public.sales
    where ambassador_id = p_ambassador_id and status = 'approved'
  ), 0)
  - coalesce((
    select sum(amount) from public.payout_requests
    where ambassador_id = p_ambassador_id
      and status in ('submitted', 'under_review', 'approved', 'paid')
  ), 0);
$$;

-- Enforce: cannot request more than available balance, cannot edit after editable_until, cannot edit locked statuses
create or replace function public.guard_payout_request()
returns trigger language plpgsql as $$
declare
  v_available numeric;
  v_ambassador uuid;
begin
  v_ambassador := coalesce(new.ambassador_id, old.ambassador_id);

  if tg_op = 'INSERT' then
    v_available := public.get_available_balance(v_ambassador);
    if new.amount > v_available then
      raise exception 'INSUFFICIENT_BALANCE';
    end if;
  end if;

  if tg_op = 'UPDATE' then
    -- Ambassadors editing their own request: only within the 60-minute window and only while submitted
    if auth.uid() = old.ambassador_id then
      if now() > old.editable_until then
        raise exception 'EDIT_WINDOW_EXPIRED';
      end if;
      if old.status <> 'submitted' then
        raise exception 'REQUEST_LOCKED';
      end if;
      if new.amount <> old.amount then
        v_available := public.get_available_balance(v_ambassador) + old.amount; -- add back old reservation
        if new.amount > v_available then
          raise exception 'INSUFFICIENT_BALANCE';
        end if;
      end if;
    end if;
  end if;

  return new;
end;
$$;

create trigger trg_payout_guard
before insert or update on public.payout_requests
for each row execute function public.guard_payout_request();

-- ------------------------------------------------------------
-- NOTIFICATIONS
-- ------------------------------------------------------------
create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  title text not null,
  message text not null,
  is_read boolean not null default false,
  created_at timestamptz not null default now()
);

create index notifications_user_idx on public.notifications (user_id, is_read);

-- Auto-notify ambassador when their payout status changes
create or replace function public.notify_payout_status_change()
returns trigger language plpgsql as $$
declare
  v_title text;
  v_message text;
begin
  if tg_op = 'UPDATE' and new.status <> old.status then
    v_title := case new.status
      when 'approved' then 'Заявката е одобрена'
      when 'paid' then 'Комисионата е изплатена'
      when 'rejected' then 'Заявката е отказана'
      when 'cancelled' then 'Заявката е анулирана'
      when 'under_review' then 'Заявката се преразглежда'
      else 'Статус на заявката е обновен'
    end;
    v_message := 'Заявка #' || new.request_number || ' на стойност ' || new.amount || ' лв.';
    insert into public.notifications (user_id, title, message)
    values (new.ambassador_id, v_title, v_message);
  end if;
  return new;
end;
$$;

create trigger trg_notify_payout_status
after update on public.payout_requests
for each row execute function public.notify_payout_status_change();

-- ------------------------------------------------------------
-- RESOURCES
-- ------------------------------------------------------------
create table public.resources (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text,
  file_url text not null,
  category text,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);

-- ------------------------------------------------------------
-- APPLICATIONS  (public "become an ambassador" form)
-- ------------------------------------------------------------
create table public.applications (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null,
  instagram text,
  tiktok text,
  portfolio text,
  message text,
  status application_status not null default 'pending',
  created_at timestamptz not null default now()
);

-- ------------------------------------------------------------
-- SETTINGS  (single row, admin-editable)
-- ------------------------------------------------------------
create table public.settings (
  id int primary key default 1 check (id = 1),
  default_commission_rate numeric(5,2) not null default 5.00,
  admin_email text not null default 'admin@todorovtees.com',
  minimum_payout_amount numeric(10,2) not null default 10.00,
  payout_editing_window_minutes int not null default 60,
  currency text not null default 'BGN',
  payment_method text not null default 'Revolut',
  allow_custom_commission_rates boolean not null default true
);
insert into public.settings (id) values (1);

-- ------------------------------------------------------------
-- AUDIT LOG  (admin-only, append-only)
-- ------------------------------------------------------------
create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id),
  action text not null,
  target_type text,
  target_id text,
  metadata jsonb,
  created_at timestamptz not null default now()
);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

alter table public.profiles enable row level security;
alter table public.sales enable row level security;
alter table public.payout_requests enable row level security;
alter table public.notifications enable row level security;
alter table public.resources enable row level security;
alter table public.applications enable row level security;
alter table public.settings enable row level security;
alter table public.audit_logs enable row level security;

-- Helper: is the current JWT an admin?
create or replace function public.is_admin()
returns boolean language sql stable as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin');
$$;

-- PROFILES: ambassadors see/edit only themselves (limited fields via app logic); admins see/edit all
create policy profiles_select on public.profiles
  for select using (auth.uid() = id or public.is_admin());
create policy profiles_update_self on public.profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);
create policy profiles_admin_all on public.profiles
  for all using (public.is_admin()) with check (public.is_admin());

-- SALES: ambassadors read-only their own; admins full access; nobody but admin can insert/update/delete
create policy sales_select_own on public.sales
  for select using (ambassador_id = auth.uid() or public.is_admin());
create policy sales_admin_write on public.sales
  for insert with check (public.is_admin());
create policy sales_admin_update on public.sales
  for update using (public.is_admin()) with check (public.is_admin());
create policy sales_admin_delete on public.sales
  for delete using (public.is_admin());

-- PAYOUT REQUESTS: ambassadors manage only their own (insert/select/limited update); admins full access
create policy payouts_select_own on public.payout_requests
  for select using (ambassador_id = auth.uid() or public.is_admin());
create policy payouts_insert_own on public.payout_requests
  for insert with check (ambassador_id = auth.uid() or public.is_admin());
create policy payouts_update_own on public.payout_requests
  for update using (ambassador_id = auth.uid() or public.is_admin())
  with check (ambassador_id = auth.uid() or public.is_admin());

-- NOTIFICATIONS: users see only their own; system/admin inserts
create policy notifications_select_own on public.notifications
  for select using (user_id = auth.uid());
create policy notifications_update_own on public.notifications
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy notifications_admin_insert on public.notifications
  for insert with check (public.is_admin() or user_id = auth.uid());

-- RESOURCES: everyone authenticated can read; only admin writes
create policy resources_select_all on public.resources
  for select using (auth.role() = 'authenticated');
create policy resources_admin_write on public.resources
  for insert with check (public.is_admin());
create policy resources_admin_update on public.resources
  for update using (public.is_admin()) with check (public.is_admin());
create policy resources_admin_delete on public.resources
  for delete using (public.is_admin());

-- APPLICATIONS: public can insert (landing page form); only admin can read/update
create policy applications_public_insert on public.applications
  for insert with check (true);
create policy applications_admin_select on public.applications
  for select using (public.is_admin());
create policy applications_admin_update on public.applications
  for update using (public.is_admin()) with check (public.is_admin());

-- SETTINGS: everyone authenticated can read; only admin writes
create policy settings_select_all on public.settings
  for select using (auth.role() = 'authenticated');
create policy settings_admin_update on public.settings
  for update using (public.is_admin()) with check (public.is_admin());

-- AUDIT LOG: admin-only read; inserts happen via service-role edge functions or authenticated triggers
create policy audit_admin_select on public.audit_logs
  for select using (public.is_admin());
create policy audit_insert_any_authenticated on public.audit_logs
  for insert with check (auth.role() = 'authenticated');

-- ------------------------------------------------------------
-- Generic audit trigger for key tables
-- ------------------------------------------------------------
create or replace function public.write_audit_log()
returns trigger language plpgsql security definer as $$
declare
  v_action text;
begin
  v_action := tg_argument[0];
  insert into public.audit_logs (user_id, action, target_type, target_id, metadata)
  values (
    auth.uid(),
    v_action,
    tg_table_name,
    coalesce(new.id, old.id)::text,
    to_jsonb(coalesce(new, old))
  );
  return coalesce(new, old);
end;
$$;

create trigger trg_audit_sale_insert after insert on public.sales
  for each row execute function public.write_audit_log('sale_added');
create trigger trg_audit_sale_update after update on public.sales
  for each row execute function public.write_audit_log('sale_edited');
create trigger trg_audit_payout_insert after insert on public.payout_requests
  for each row execute function public.write_audit_log('payout_created');
create trigger trg_audit_payout_update after update on public.payout_requests
  for each row execute function public.write_audit_log('payout_status_changed');
create trigger trg_audit_profile_update after update on public.profiles
  for each row execute function public.write_audit_log('ambassador_modified');
