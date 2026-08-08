// js/sales.js — ambassador's own sales, read-only

import { supabase } from "./api.js";
import { requireAuth, bindSidebarToggle } from "./auth.js";

function renderRows(sales) {
  const tbody = document.getElementById("sales-body");
  if (!sales || sales.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6"><div class="empty-state"><span class="eyebrow">Няма продажби</span>Продажбите се въвеждат от администратор и ще се появят тук след одобрение.</div></td></tr>`;
    return;
  }
  tbody.innerHTML = sales.map((s) => `
    <tr>
      <td data-label="Поръчка" class="mono">#${s.order_number}</td>
      <td data-label="Дата">${new Date(s.sale_date).toLocaleDateString("bg-BG")}</td>
      <td data-label="Стойност на поръчката" class="mono">${Number(s.sale_value).toFixed(2)} €</td>
      <td data-label="Процент комисиона" class="mono">${s.commission_rate}%</td>
      <td data-label="Комисиона" class="mono">${Number(s.commission_amount).toFixed(2)} €</td>
      <td data-label="Статус"><span class="pill pill-${s.status}">${labelFor(s.status)}</span></td>
    </tr>`).join("");
}

function labelFor(status) {
  return { pending: "Изчакваща", approved: "Одобрена", cancelled: "Отменена", rejected: "Отказана" }[status] || status;
}

async function loadSales(profileId, statusFilter) {
  let query = supabase.from("sales").select("*").eq("ambassador_id", profileId).order("sale_date", { ascending: false });
  if (statusFilter) query = query.eq("status", statusFilter);
  const { data, error } = await query;
  if (error) { console.error(error); return; }
  renderRows(data);
}

(async function init() {
  const profile = await requireAuth("ambassador");
  if (!profile) return;
  bindSidebarToggle();

  const filter = document.getElementById("status-filter");
  await loadSales(profile.id, filter?.value || "");
  filter?.addEventListener("change", () => loadSales(profile.id, filter.value));
})();
