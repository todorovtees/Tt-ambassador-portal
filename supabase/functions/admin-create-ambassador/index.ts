// supabase/functions/admin-create-ambassador/index.ts
//
// Runs ONLY on Supabase's servers. Uses the service-role key (never shipped
// to the browser) to create an auth user and send a secure invite email.
// The admin never sees or sets a password — the ambassador creates their
// own via the invite link, satisfying section 2 / 20 of the spec.
//
// Deploy:  supabase functions deploy admin-create-ambassador
// Secrets: supabase secrets set SUPABASE_SERVICE_ROLE_KEY=... SITE_URL=...

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SITE_URL = Deno.env.get("SITE_URL") ?? "http://localhost:5173";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const callerClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      global: { headers: { Authorization: authHeader } },
    });

    // 1. Verify the caller is an authenticated admin (never trust the frontend claim)
    const { data: { user }, error: userErr } = await callerClient.auth.getUser();
    if (userErr || !user) {
      return json({ error: "UNAUTHENTICATED" }, 401);
    }
    const { data: callerProfile } = await callerClient
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .single();
    if (callerProfile?.role !== "admin") {
      return json({ error: "FORBIDDEN" }, 403);
    }

    const body = await req.json();
    const { first_name, last_name, email, commission_rate, instagram, tiktok, phone, status } = body;

    if (!first_name || !last_name || !email) {
      return json({ error: "MISSING_FIELDS" }, 400);
    }

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // 2. Invite the ambassador — Supabase sends a secure setup-your-password email.
    //    No password is ever generated or stored by this function.
    const { data: invited, error: inviteErr } = await admin.auth.admin.inviteUserByEmail(email, {
      redirectTo: `${SITE_URL}/login.html?setup=1`,
    });
    if (inviteErr) return json({ error: inviteErr.message }, 400);

    // 3. Create the profile row
    const { error: profileErr } = await admin.from("profiles").insert({
      id: invited.user.id,
      role: "ambassador",
      first_name,
      last_name,
      email,
      phone: phone ?? null,
      instagram: instagram ?? null,
      tiktok: tiktok ?? null,
      commission_rate: commission_rate ?? 5.0,
      status: status ?? "active",
    });
    if (profileErr) return json({ error: profileErr.message }, 400);

    // 4. Audit log
    await admin.from("audit_logs").insert({
      user_id: user.id,
      action: "ambassador_created",
      target_type: "profiles",
      target_id: invited.user.id,
      metadata: { email },
    });

    return json({ ok: true, id: invited.user.id });
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
