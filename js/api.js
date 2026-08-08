// js/api.js — Supabase client + shared helpers used across every page.
//
// The anon key below is SAFE to expose in frontend code: it grants no 
// access on its own. Every table is protected by Row Level Security
// policies defined in supabase/migrations/0001_init.sql, so the database
// itself enforces "ambassadors see only their own data" and
// "only admins write sales / commission rates" — not this file.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Populate these from your Supabase project settings (Project Settings > API).
// Do NOT put the service_role key here — ever.
export const SUPABASE_URL = window.__TT_CONFIG__?.SUPABASE_URL || "https://YOUR-PROJECT.supabase.co";
export const SUPABASE_ANON_KEY = window.__TT_CONFIG__?.SUPABASE_ANON_KEY || "YOUR-ANON-KEY";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
export function functionsUrl(name) {
  return `${SUPABASE_URL}/functions/v1/${name}`;
}

/* ---------------- Formatting ---------------- */
export function formatBGN(amount) {
  const n = Number(amount || 0);
return n.toLocaleString("bg-BG", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";}

export function formatDate(dateStr) {
  if (!dateStr) return "—";
  const d = new Date(dateStr);
  return d.toLocaleDateString("bg-BG", { day: "2-digit", month: "2-digit", year: "numeric" });
}

export function formatDateTime(dateStr) {
  if (!dateStr) return "—";
  const d = new Date(dateStr);
  return d.toLocaleString("bg-BG", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

/* ---------------- Status labels (Bulgarian) ---------------- */
export const SALE_STATUS_LABELS = {
  pending: "Изчакваща",
  approved: "Одобрена",
  cancelled: "Отменена",
  rejected: "Отказана",
};

export const PAYOUT_STATUS_LABELS = {
  submitted: "Подадена",
  under_review: "Преглежда се",
  approved: "Одобрена",
  paid: "Изплатена",
  rejected: "Отказана",
  cancelled: "Анулирана",
};

/* ---------------- Toasts ---------------- */
export function toast(message, type = "success") {
  let root = document.getElementById("toast-root");
  if (!root) {
    root = document.createElement("div");
    root.id = "toast-root";
    document.body.appendChild(root);
  }
  const el = document.createElement("div");
  el.className = "toast" + (type === "error" ? " toast-error" : "");
  el.textContent = message;
  root.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

/* ---------------- Friendly Bulgarian error mapping ---------------- */
const ERROR_MESSAGES = {
  INSUFFICIENT_BALANCE: "Недостатъчна налична комисиона.",
  EDIT_WINDOW_EXPIRED: "Периодът за редакция на заявката е изтекъл.",
  REQUEST_LOCKED: "Заявката вече не може да бъде редактирана.",
  invalid_credentials: "Невалиден имейл или парола.",
  UNAUTHENTICATED: "Моля, влезте отново в профила си.",
  FORBIDDEN: "Нямате права за това действие.",
};

export function friendlyError(err) {
  const raw = err?.message || String(err || "");
  for (const key of Object.keys(ERROR_MESSAGES)) {
    if (raw.includes(key)) return ERROR_MESSAGES[key];
  }
  return "Възникна техническа грешка. Моля, опитайте отново.";
}

/* ---------------- Balance calculation (mirrors DB function for instant UI feedback) ---------------- */
export async function getAvailableBalance(ambassadorId) {
  const { data, error } = await supabase.rpc("get_available_balance", { p_ambassador_id: ambassadorId });
  if (error) throw error;
  return Number(data || 0);
}

/* ---------------- Button loading state (prevents duplicate submissions) ---------------- */
export function withLoading(button, fn) {
  return async (...args) => {
    if (button.disabled) return;
    const original = button.innerHTML;
    button.disabled = true;
    button.innerHTML = '<span class="spinner" aria-hidden="true"></span>';
    try {
      await fn(...args);
    } finally {
      button.disabled = false;
      button.innerHTML = original;
    }
  };
}

/* ---------------- Confirm dialog (lightweight, no browser confirm()) ---------------- */
export function confirmAction(message) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML = `
      <div class="modal" role="alertdialog" aria-modal="true">
        <p style="margin-bottom:24px; font-size:15px;">${message}</p>
        <div style="display:flex; gap:12px;">
          <button class="btn btn-secondary" data-action="cancel">Отказ</button>
          <button class="btn btn-primary" data-action="confirm">Потвърди</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay || e.target.dataset.action === "cancel") {
        overlay.remove();
        resolve(false);
      } else if (e.target.dataset.action === "confirm") {
        overlay.remove();
        resolve(true);
      }
    });
  });
}
