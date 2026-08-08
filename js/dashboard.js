// js/dashboard.js — ambassador dashboard: stat cards + notifications badge

import { supabase, formatBGN, getAvailableBalance } from "./api.js";
import { requireAuth, bindSidebarToggle } from "./auth.js";

async function loadNotifBadge(profileId) {
  const { count } = await supabase
    .from("notifications")
    .select("*", { count: "exact", head: true })
    .eq("user_id", profileId)
    .eq("is_read", false);
  document.querySelectorAll("[data-notif-badge]").forEach((el) => {
    if (count > 0) {
      el.textContent = count > 9 ? "9+" : String(count);
      el.style.display = "flex";
    } else {
      el.style.display = "none";
    }
  });
}

async function loadStats(profile) {
  const [{ data: sales }, available] = await Promise.all([
    supabase.from("sales").select("sale_value, commission_amount, status").eq("ambassador_id", profile.id),
    getAvailableBalance(profile.id),
  ]);

  const approved = (sales || []).filter((s) => s.status === "approved");
  const totalSalesCount = approved.length;
  const totalSalesValue = approved.reduce((sum, s) => sum + Number(s.sale_value), 0);

  const { data: payouts } = await supabase
    .from("payout_requests")
    .select("amount, status")
    .eq("ambassador_id", profile.id);

  const pending = (payouts || [])
    .filter((p) => ["submitted", "under_review", "approved"].includes(p.status))
    .reduce((sum, p) => sum + Number(p.amount), 0);
  const paid = (payouts || [])
    .filter((p) => p.status === "paid")
    .reduce((sum, p) => sum + Number(p.amount), 0);

  set("stat-total-sales", totalSalesCount);
  set("stat-sales-value", formatBGN(totalSalesValue));
  set("stat-commission-rate", `${profile.commission_rate}%`);
  set("stat-available", formatBGN(available));
  set("stat-pending", formatBGN(pending));
  set("stat-paid", formatBGN(paid));
}

function set(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

async function loadRecentSales(profile) {
  const { data } = await supabase
    .from("sales")
    .select("*")
    .eq("ambassador_id", profile.id)
    .order("created_at", { ascending: false })
    .limit(5);

  const tbody = document.getElementById("recent-sales-body");
  if (!tbody) return;
  if (!data || data.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5"><div class="empty-state"><span class="eyebrow">Няма продажби</span>Все още няма регистрирани продажби.</div></td></tr>`;
    return;
  }
  tbody.innerHTML = data.map((s) => `
    <tr>
      <td data-label="Поръчка" class="mono">#${s.order_number}</td>
      <td data-label="Дата">${new Date(s.sale_date).toLocaleDateString("bg-BG")}</td>
      <td data-label="Стойност" class="mono">${Number(s.sale_value).toFixed(2)} €</td>
      <td data-label="Комисиона" class="mono">${Number(s.commission_amount).toFixed(2)} €</td>
      <td data-label="Статус"><span class="pill pill-${s.status}">${s.status}</span></td>
    </tr>`).join("");
}

(async function init() {
  const profile = await requireAuth("ambassador");
  if (!profile) return;
  bindSidebarToggle();
  await Promise.all([loadStats(profile), loadNotifBadge(profile.id), loadRecentSales(profile)]);
})();
