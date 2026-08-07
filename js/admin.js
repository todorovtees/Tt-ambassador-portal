// js/admin.js — all admin-only pages import from here by page id

import { supabase, formatBGN, formatDate, formatDateTime, toast, friendlyError, confirmAction } from "./api.js";
import { requireAuth, bindSidebarToggle } from "./auth.js";

export let adminProfile = null;

export async function initAdminPage() {
  adminProfile = await requireAuth("admin");
  if (!adminProfile) return null;
  bindSidebarToggle();
  return adminProfile;
}

/* ================= DASHBOARD ================= */
export async function loadAdminDashboard() {
  const [{ count: ambassadorCount }, { count: activeCount }, { data: sales }, { data: payouts }] = await Promise.all([
    supabase.from("profiles").select("*", { count: "exact", head: true }).eq("role", "ambassador"),
    supabase.from("profiles").select("*", { count: "exact", head: true }).eq("role", "ambassador").eq("status", "active"),
    supabase.from("sales").select("sale_value, commission_amount, status"),
    supabase.from("payout_requests").select("amount, status"),
  ]);

  const approvedSales = (sales || []).filter((s) => s.status === "approved");
  const totalSalesValue = approvedSales.reduce((s, x) => s + Number(x.sale_value), 0);
  const totalCommissions = approvedSales.reduce((s, x) => s + Number(x.commission_amount), 0);
  const pendingPayouts = (payouts || []).filter((p) => ["submitted", "under_review", "approved"].includes(p.status)).reduce((s, x) => s + Number(x.amount), 0);
  const paidPayouts = (payouts || []).filter((p) => p.status === "paid").reduce((s, x) => s + Number(x.amount), 0);

  set("stat-ambassadors", ambassadorCount ?? 0);
  set("stat-active", activeCount ?? 0);
  set("stat-total-sales", (sales || []).length);
  set("stat-sales-value", formatBGN(totalSalesValue));
  set("stat-commissions", formatBGN(totalCommissions));
  set("stat-pending-payouts", formatBGN(pendingPayouts));
  set("stat-paid-payouts", formatBGN(paidPayouts));
}

function set(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; }

/* ================= AMBASSADORS ================= */
export async function loadAmbassadors(searchTerm = "") {
  let query = supabase.from("profiles").select("*").eq("role", "ambassador").order("created_at", { ascending: false });
  if (searchTerm) query = query.or(`first_name.ilike.%${searchTerm}%,last_name.ilike.%${searchTerm}%,email.ilike.%${searchTerm}%`);
  const { data, error } = await query;
  if (error) { console.error(error); return; }

  const tbody = document.getElementById("ambassadors-body");
  if (!tbody) return;
  if (!data || data.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state"><span class="eyebrow">Няма амбасадори</span>Добавете първия амбасадор, за да започнете.</div></td></tr>`;
    return;
  }
  tbody.innerHTML = data.map((a) => `
    <tr data-id="${a.id}">
      <td data-label="Име">${a.first_name} ${a.last_name}</td>
      <td data-label="Имейл">${a.email}</td>
      <td data-label="Комисиона" class="mono">${a.commission_rate}%</td>
      <td data-label="Статус"><span class="pill pill-${a.status === 'active' ? 'approved' : 'rejected'}">${statusLabel(a.status)}</span></td>
      <td data-label="Присъединен">${formatDate(a.created_at)}</td>
      <td data-label=""><button class="btn btn-ghost btn-inline" data-view="${a.id}">Преглед</button></td>
    </tr>`).join("");

  tbody.querySelectorAll("[data-view]").forEach((btn) => {
    btn.addEventListener("click", () => window.location.href = `ambassadors.html?id=${btn.dataset.view}`);
  });
}

function statusLabel(s) { return { active: "Активен", suspended: "Спрян", deactivated: "Деактивиран" }[s] || s; }

export async function createAmbassador(payload) {
  const { data: { session } } = await supabase.auth.getSession();
  const res = await fetch(`${supabase.supabaseUrl}/functions/v1/admin-create-ambassador`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
    body: JSON.stringify(payload),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || "CREATE_FAILED");
  return json;
}

export async function updateAmbassador(id, patch) {
  const { error } = await supabase.from("profiles").update(patch).eq("id", id);
  if (error) throw error;
}

/* ================= SALES ================= */
export async function loadAllSales(filters = {}) {
  let query = supabase.from("sales").select("*, profiles!sales_ambassador_id_fkey(first_name,last_name)").order("sale_date", { ascending: false });
  if (filters.status) query = query.eq("status", filters.status);
  if (filters.ambassadorId) query = query.eq("ambassador_id", filters.ambassadorId);
  const { data, error } = await query;
  if (error) { console.error(error); return []; }
  return data || [];
}

export async function addSale(payload) {
  const { error } = await supabase.from("sales").insert(payload);
  if (error) throw error;
}

export async function updateSale(id, patch) {
  const { error } = await supabase.from("sales").update(patch).eq("id", id);
  if (error) throw error;
}

export async function loadAmbassadorOptions(selectEl) {
  const { data } = await supabase.from("profiles").select("id, first_name, last_name, commission_rate").eq("role", "ambassador").eq("status", "active");
  selectEl.innerHTML = (data || []).map((a) => `<option value="${a.id}" data-rate="${a.commission_rate}">${a.first_name} ${a.last_name}</option>`).join("");
}

/* ================= PAYOUTS ================= */
export async function loadAllPayouts(statusFilter = "") {
  let query = supabase.from("payout_requests").select("*, profiles!payout_requests_ambassador_id_fkey(first_name,last_name)").order("created_at", { ascending: false });
  if (statusFilter) query = query.eq("status", statusFilter);
  const { data, error } = await query;
  if (error) { console.error(error); return []; }
  return data || [];
}

export async function setPayoutStatus(id, status, extra = {}) {
  const { error } = await supabase.from("payout_requests").update({ status, ...extra }).eq("id", id);
  if (error) throw error;
  notifyPayoutEvent(status === "submitted" ? "created" : "status_changed", id);
}

async function notifyPayoutEvent(event, payoutId) {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    await fetch(`${supabase.supabaseUrl}/functions/v1/notify-payout-event`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ event, payout_id: payoutId }),
    });
  } catch { /* non-critical */ }
}

/* ================= AUDIT LOG ================= */
export async function loadAuditLog() {
  const { data, error } = await supabase.from("audit_logs").select("*, profiles(first_name,last_name)").order("created_at", { ascending: false }).limit(200);
  if (error) { console.error(error); return []; }
  return data || [];
}

export { formatBGN, formatDate, formatDateTime, toast, friendlyError, confirmAction };
