// js/auth.js — login/logout + role-guarding for every protected page.
//
// IMPORTANT: this only controls what the UI *shows*. The real protection
// is server-side: Row Level Security policies on every table mean that
// even if someone bypasses this guard by editing the page, the database
// will refuse to return or accept data they're not allowed to touch.

import { supabase, toast, friendlyError } from "./api.js";

export async function login(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

export async function logout() {
  await supabase.auth.signOut();
  window.location.href = "/login.html";
}

export async function getCurrentProfile() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return null;
  const { data, error } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", session.user.id)
    .single();
  if (error) return null;
  return data;
}

/**
 * Call at the top of every protected page.
 * requiredRole: "admin" | "ambassador" | null (any authenticated user)
 * Redirects to login if unauthenticated, or to the correct dashboard if
 * the wrong role tries to access a page (defense in depth — RLS is the
 * real backstop, this just avoids a confusing dead page).
 */
export async function requireAuth(requiredRole = null) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    window.location.href = "/login.html";
    return null;
  }
  const profile = await getCurrentProfile();
  if (!profile) {
    window.location.href = "/login.html";
    return null;
  }
  if (profile.status !== "active" && profile.role !== "admin") {
    toast("Профилът е деактивиран. Свържете се с администратор.", "error");
    await logout();
    return null;
  }
  if (requiredRole && profile.role !== requiredRole) {
    window.location.href = profile.role === "admin" ? "/admin/dashboard.html" : "/ambassador/dashboard.html";
    return null;
  }
  renderUserChrome(profile);
  return profile;
}

function renderUserChrome(profile) {
  document.querySelectorAll("[data-user-name]").forEach((el) => {
    el.textContent = `${profile.first_name} ${profile.last_name}`;
  });
  document.querySelectorAll("[data-user-first-name]").forEach((el) => {
    el.textContent = profile.first_name;
  });
  document.querySelectorAll("[data-logout]").forEach((el) => {
    el.addEventListener("click", async (e) => {
      e.preventDefault();
      await logout();
    });
  });
}

export function bindLoginForm(formEl) {
  formEl.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = formEl.email.value.trim();
    const password = formEl.password.value;
    const submitBtn = formEl.querySelector('button[type="submit"]');
    const original = submitBtn.innerHTML;
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<span class="spinner" aria-hidden="true"></span>';
    try {
      await login(email, password);
      const profile = await getCurrentProfile();
      window.location.href = profile?.role === "admin" ? "/admin/dashboard.html" : "/ambassador/dashboard.html";
    } catch (err) {
      toast(friendlyError(err), "error");
      submitBtn.disabled = false;
      submitBtn.innerHTML = original;
    }
  });
}

/* Mobile sidebar drawer toggle — shared by every dashboard page */
export function bindSidebarToggle() {
  const hamburger = document.querySelector("[data-hamburger]");
  const sidebar = document.querySelector(".sidebar");
  const backdrop = document.querySelector(".sidebar-backdrop");
  if (!hamburger || !sidebar) return;
  const open = () => { sidebar.classList.add("open"); backdrop?.classList.add("open"); };
  const close = () => { sidebar.classList.remove("open"); backdrop?.classList.remove("open"); };
  hamburger.addEventListener("click", open);
  backdrop?.addEventListener("click", close);
}
