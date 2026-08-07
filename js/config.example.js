// js/config.example.js
//
// Copy this file to config.js (which is gitignored) and fill in your
// Supabase project's URL and anon (public) key from:
// Supabase Dashboard → Project Settings → API
//
// The anon key is safe to ship to the browser — it has no power on its
// own. Row Level Security policies on every table are what actually
// enforce who can read/write what. NEVER put the service_role key here.
//
// Then include this script BEFORE any module scripts on each HTML page:
// <script src="/js/config.js"></script>

window.__TT_CONFIG__ = {
  SUPABASE_URL: "https://YOUR-PROJECT-REF.supabase.co",
  SUPABASE_ANON_KEY: "YOUR-ANON-PUBLIC-KEY",
};
