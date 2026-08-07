// js/payouts.js — withdraw modal, payout list, 60-minute edit countdown

import { supabase, formatBGN, formatDate, toast, friendlyError, getAvailableBalance, confirmAction } from "./api.js";
import { requireAuth, bindSidebarToggle } from "./auth.js";

let currentProfile = null;

function labelFor(status) {
  return {
    submitted: "Подадена", under_review: "Преглежда се", approved: "Одобрена",
    paid: "Изплатена", rejected: "Отказана", cancelled: "Анулирана",
  }[status] || status;
}

/* ---------------- Withdraw modal ---------------- */
function openWithdrawModal(available) {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal">
      <h2 style="font-size:20px; margin-bottom:4px;">Изтегли комисиона</h2>
      <p class="eyebrow" style="margin-bottom:24px;">Налични: <span class="mono">${formatBGN(available)}</span></p>
      <form id="withdraw-form">
        <div class="field">
          <label for="wd-first">Име</label>
          <input id="wd-first" name="first_name" required value="${currentProfile.first_name}" />
        </div>
        <div class="field">
          <label for="wd-last">Фамилия</label>
          <input id="wd-last" name="last_name" required value="${currentProfile.last_name}" />
        </div>
        <div class="field">
          <label for="wd-revolut">Revolut идентификатор</label>
          <input id="wd-revolut" name="revolut_identifier" required placeholder="@username" value="${currentProfile.revolut_identifier || ''}" />
        </div>
        <div class="field" id="amount-field">
          <label for="wd-amount">Сума за теглене (лв.)</label>
          <input id="wd-amount" name="amount" type="number" min="0.01" step="0.01" max="${available}" required />
          <span class="error-text" id="amount-error"></span>
        </div>
        <div style="display:flex; gap:12px; margin-top:24px;">
          <button type="button" class="btn btn-secondary" data-close>Отказ</button>
          <button type="submit" class="btn btn-primary btn-block">ПОТВЪРДИ ИЗТЕГЛЯНЕ</button>
        </div>
      </form>
    </div>`;
  document.body.appendChild(overlay);

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay || e.target.dataset.close !== undefined) overlay.remove();
  });

  const form = overlay.querySelector("#withdraw-form");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const amountField = document.getElementById("amount-field");
    const amountError = document.getElementById("amount-error");
    const amount = Number(form.amount.value);

    amountField.classList.remove("has-error");
    if (!amount || amount <= 0) {
      amountField.classList.add("has-error");
      amountError.textContent = "Сумата трябва да бъде по-голяма от 0.";
      return;
    }
    if (amount > available) {
      amountField.classList.add("has-error");
      amountError.textContent = "Не можете да изтеглите повече от наличния баланс.";
      return;
    }

    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<span class="spinner"></span>';

    try {
      const { data, error } = await supabase
        .from("payout_requests")
        .insert({
          ambassador_id: currentProfile.id,
          first_name: form.first_name.value.trim(),
          last_name: form.last_name.value.trim(),
          revolut_identifier: form.revolut_identifier.value.trim(),
          amount,
        })
        .select()
        .single();
      if (error) throw error;

      // Fire-and-forget admin email notification via edge function
      notifyPayoutEvent("created", data.id);

      overlay.remove();
      showConfirmation(data);
      await loadPayouts();
    } catch (err) {
      amountField.classList.add("has-error");
      amountError.textContent = friendlyError(err);
      submitBtn.disabled = false;
      submitBtn.innerHTML = "ПОТВЪРДИ ИЗТЕГЛЯНЕ";
    }
  });
}

async function notifyPayoutEvent(event, payoutId) {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    await fetch(`${supabase.supabaseUrl}/functions/v1/notify-payout-event`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ event, payout_id: payoutId }),
    });
  } catch {
    /* Non-critical — the in-app notification and DB record are the source of truth */
  }
}

function showConfirmation(request) {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal" style="text-align:center;">
      <div class="eyebrow" style="margin-bottom:16px;">Успешно</div>
      <h2 style="font-size:20px; margin-bottom:12px;">Заявката за изплащане е създадена успешно.</h2>
      <p style="color:var(--gray-warm); margin-bottom:24px;">Вашата заявка ще бъде прегледана и изплатена в най-кратък срок.</p>
      <div class="card" style="text-align:left; margin-bottom:24px;">
        <div style="display:flex; justify-content:space-between; padding:6px 0;"><span>Заявка</span><span class="mono">#${request.request_number}</span></div>
        <div style="display:flex; justify-content:space-between; padding:6px 0;"><span>Сума</span><span class="mono">${formatBGN(request.amount)}</span></div>
        <div style="display:flex; justify-content:space-between; padding:6px 0;"><span>Статус</span><span class="pill pill-${request.status}">${labelFor(request.status)}</span></div>
      </div>
      <button class="btn btn-primary btn-block" data-close>Разбрах</button>
    </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay || e.target.dataset.close !== undefined) overlay.remove();
  });
}

/* ---------------- List + edit ---------------- */
function startCountdown(el, editableUntil) {
  function tick() {
    const diff = new Date(editableUntil) - new Date();
    if (diff <= 0) {
      el.textContent = "Периодът за редакция е изтекъл.";
      return;
    }
    const mins = Math.floor(diff / 60000);
    const secs = Math.floor((diff % 60000) / 1000);
    el.textContent = `Можете да редактирате тази заявка още: ${mins}:${String(secs).padStart(2, "0")}`;
    setTimeout(tick, 1000);
  }
  tick();
}

async function loadPayouts() {
  const { data, error } = await supabase
    .from("payout_requests")
    .select("*")
    .eq("ambassador_id", currentProfile.id)
    .order("created_at", { ascending: false });
  if (error) { console.error(error); return; }

  const tbody = document.getElementById("payouts-body");
  if (!data || data.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6"><div class="empty-state"><span class="eyebrow">Няма заявки</span>Все още нямате заявки за изплащане.</div></td></tr>`;
    return;
  }
  tbody.innerHTML = data.map((p) => `
    <tr data-id="${p.id}">
      <td data-label="Заявка" class="mono">#${p.request_number}</td>
      <td data-label="Дата">${formatDate(p.created_at)}</td>
      <td data-label="Сума" class="mono">${formatBGN(p.amount)}</td>
      <td data-label="Статус"><span class="pill pill-${p.status}">${labelFor(p.status)}</span></td>
      <td data-label="Обновена">${formatDate(p.updated_at)}</td>
      <td data-label="">${p.status === "submitted" && new Date(p.editable_until) > new Date()
        ? `<button class="btn btn-ghost btn-inline" data-edit="${p.id}">Редактирай</button>`
        : ""}</td>
    </tr>`).join("");

  tbody.querySelectorAll("[data-edit]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const row = data.find((p) => p.id === btn.dataset.edit);
      openEditModal(row);
    });
  });
}

function openEditModal(request) {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal">
      <h2 style="font-size:20px; margin-bottom:8px;">Редактирай заявка #${request.request_number}</h2>
      <p class="countdown" id="edit-countdown" style="margin-bottom:20px;"></p>
      <form id="edit-form">
        <div class="field">
          <label for="ed-revolut">Revolut идентификатор</label>
          <input id="ed-revolut" name="revolut_identifier" required value="${request.revolut_identifier}" />
        </div>
        <div class="field" id="ed-amount-field">
          <label for="ed-amount">Сума (лв.)</label>
          <input id="ed-amount" name="amount" type="number" min="0.01" step="0.01" required value="${request.amount}" />
          <span class="error-text" id="ed-amount-error"></span>
        </div>
        <div style="display:flex; gap:12px; margin-top:24px;">
          <button type="button" class="btn btn-secondary" data-close>Затвори</button>
          <button type="submit" class="btn btn-primary btn-block">ЗАПАЗИ ПРОМЕНИТЕ</button>
        </div>
      </form>
    </div>`;
  document.body.appendChild(overlay);
  startCountdown(document.getElementById("edit-countdown"), request.editable_until);

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay || e.target.dataset.close !== undefined) overlay.remove();
  });

  const form = overlay.querySelector("#edit-form");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const amountField = document.getElementById("ed-amount-field");
    const amountError = document.getElementById("ed-amount-error");
    amountField.classList.remove("has-error");

    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<span class="spinner"></span>';

    try {
      const { error } = await supabase
        .from("payout_requests")
        .update({
          revolut_identifier: form.revolut_identifier.value.trim(),
          amount: Number(form.amount.value),
        })
        .eq("id", request.id);
      if (error) throw error;
      toast("Заявката е обновена успешно.");
      overlay.remove();
      await loadPayouts();
    } catch (err) {
      amountField.classList.add("has-error");
      amountError.textContent = friendlyError(err);
      submitBtn.disabled = false;
      submitBtn.innerHTML = "ЗАПАЗИ ПРОМЕНИТЕ";
    }
  });
}

(async function init() {
  currentProfile = await requireAuth("ambassador");
  if (!currentProfile) return;
  bindSidebarToggle();

  const available = await getAvailableBalance(currentProfile.id);
  const availEl = document.getElementById("available-balance");
  if (availEl) availEl.textContent = formatBGN(available);

  document.getElementById("withdraw-btn")?.addEventListener("click", async () => {
    const fresh = await getAvailableBalance(currentProfile.id);
    if (fresh <= 0) {
      toast("Недостатъчна налична комисиона.", "error");
      return;
    }
    openWithdrawModal(fresh);
  });

  await loadPayouts();
})();
