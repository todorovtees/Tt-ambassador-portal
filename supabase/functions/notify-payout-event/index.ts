// supabase/functions/notify-payout-event/index.ts
//
// Sends email notifications for payout lifecycle events.
// Called from the frontend AFTER a payout request insert/update succeeds
// (RLS already protected the actual data write — this just handles email).
// Uses Resend; swap the fetch call for any provider you prefer.
//
// Deploy:  supabase functions deploy notify-payout-event
// Secrets: supabase secrets set RESEND_API_KEY=... SUPABASE_SERVICE_ROLE_KEY=...

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const FROM_EMAIL = Deno.env.get("NOTIFY_FROM_EMAIL") ?? "portal@todorovtees.com";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const caller = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user } } = await caller.auth.getUser();
    if (!user) return json({ error: "UNAUTHENTICATED" }, 401);

    const { event, payout_id } = await req.json();
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    const { data: payout } = await admin
      .from("payout_requests")
      .select("*, profiles!payout_requests_ambassador_id_fkey(first_name,last_name,email)")
      .eq("id", payout_id)
      .single();
    if (!payout) return json({ error: "NOT_FOUND" }, 404);

    const { data: settings } = await admin.from("settings").select("admin_email").single();

    let to: string, subject: string, text: string;

    if (event === "created") {
      to = settings?.admin_email ?? "admin@todorovtees.com";
      subject = "Нова заявка за изплащане на комисиона";
text = `Амбасадор: ${payout.profiles.first_name} ${payout.profiles.last_name}\nСума: ${payout.amount} €\nЗаявка: #${payout.request_number}\nСтатус: Подадена`;
    } else {
      to = payout.profiles.email;
      const statusText: Record<string, string> = {
        approved: "одобрена",
        paid: "изплатена",
        rejected: "отказана",
        cancelled: "анулирана",
        under_review: "в преглед",
      };
      subject = `Заявка #${payout.request_number} — ${statusText[payout.status] ?? payout.status}`;
text = `Вашата заявка за изплащане на ${payout.amount} € вече е със статус: ${statusText[payout.status] ?? payout.status}.`;
    }

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: FROM_EMAIL, to, subject, text }),
    });

    if (!res.ok) return json({ error: await res.text() }, 502);
    return json({ ok: true });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
