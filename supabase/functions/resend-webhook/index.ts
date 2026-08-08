
// supabase/functions/resend-webhook/index.ts
//
// Receives delivery-status events from Resend (sent, delivered, bounced,
// complained, etc.) and records them in audit_logs so the admin has
// visibility into whether invitation/notification emails actually arrived.
//
// Deploy:  supabase functions deploy resend-webhook --no-verify-jwt
//          (--no-verify-jwt is required: Resend calls this anonymously,
//          not with a Supabase user JWT — signature verification below
//          is what actually authenticates the request instead)
// Secrets: supabase secrets set RESEND_WEBHOOK_SECRET=whsec_...
//          (get this from Resend Dashboard → Webhooks → your endpoint → Signing Secret)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Webhook } from "https://esm.sh/svix@1.24.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WEBHOOK_SECRET = Deno.env.get("RESEND_WEBHOOK_SECRET")!;

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const payload = await req.text();
  const headers = {
    "svix-id": req.headers.get("svix-id") ?? "",
    "svix-timestamp": req.headers.get("svix-timestamp") ?? "",
    "svix-signature": req.headers.get("svix-signature") ?? "",
  };

  // Verify this request genuinely came from Resend before trusting it
  let event;
  try {
    const wh = new Webhook(WEBHOOK_SECRET);
    event = wh.verify(payload, headers);
  } catch {
    return new Response("Invalid signature", { status: 401 });
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const type = event.type as string; // e.g. "email.delivered", "email.bounced", "email.complained"
  const data = event.data as { to?: string[]; subject?: string; email_id?: string };

  await admin.from("audit_logs").insert({
    user_id: null,
    action: `email_${type.replace("email.", "")}`,
    target_type: "email",
    target_id: data.email_id ?? null,
    metadata: { to: data.to, subject: data.subject, type },
  });

  return new Response(JSON.stringify({ ok: true }), {
    headers: { "Content-Type": "application/json" },
  });
});
