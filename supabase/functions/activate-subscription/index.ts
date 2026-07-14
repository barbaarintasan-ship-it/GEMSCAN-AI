// Website → app activation bridge.
//
// Called by the WordPress payment plugin (server-to-server) after a payment is
// confirmed. Protected by a shared secret (ACTIVATION_SECRET) rather than a user
// JWT, because the caller is the website, not a logged-in app user. It looks up
// the account by email and upserts its subscription so the mobile app shows
// Premium on next open. Does NOT touch the identification pipeline.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { corsHeaders } from "../_shared/cors.ts";

// Marketing plan names → internal entitlement tier.
const PLAN_TIER: Record<string, string> = {
  "explorer": "premium",
  "gem collector": "professional",
  "collector": "professional",
  "premium": "premium",
  "professional": "professional",
};

const ALLOWED_SOURCES = [
  "stripe", "paypal",
  "mobile_money_evc", "mobile_money_zaad", "mobile_money_sahal", "mobile_money_edahab",
  "bank_transfer",
];

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const secret = Deno.env.get("ACTIVATION_SECRET");
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

    // Shared-secret auth — reject anything that doesn't present it.
    if (!secret || String(body.secret ?? "") !== secret) {
      return json({ error: "unauthorized" }, 401);
    }

    const email = String(body.email ?? "").trim().toLowerCase();
    const action = String(body.action ?? "").trim();
    if (!email) return json({ error: "email is required" }, 400);

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Read-only: return the account's current plan (for the website "account" area).
    if (action === "status") {
      const { data: p } = await admin.from("profiles").select("id").eq("email", email).maybeSingle();
      if (!p) return json({ ok: true, account: false, tier: "free", active: false, expires: null });
      const { data: sub } = await admin
        .from("subscriptions")
        .select("tier, status, current_period_end")
        .eq("user_id", p.id)
        .maybeSingle();
      const active = sub?.status === "active";
      return json({
        ok: true,
        account: true,
        tier: active ? sub!.tier : "free",
        active,
        expires: sub?.current_period_end ?? null,
      });
    }

    const planKey = String(body.plan ?? "").trim().toLowerCase();
    const months = Number(body.months ?? 12) || 12;
    const method = String(body.method ?? "").trim();
    const reference = body.reference ? String(body.reference) : null;
    const tier = PLAN_TIER[planKey];
    if (!tier) return json({ error: "a valid plan is required" }, 400);

    // Resolve the account by email (profiles.id === auth user id).
    const { data: profile } = await admin
      .from("profiles")
      .select("id")
      .eq("email", email)
      .maybeSingle();
    if (!profile) return json({ error: "no account found with that email" }, 404);

    const now = new Date();
    const end = new Date(now.getTime());
    end.setMonth(end.getMonth() + months);
    const source = ALLOWED_SOURCES.includes(method) ? method : null;

    const { error } = await admin.from("subscriptions").upsert(
      {
        user_id: profile.id,
        tier,
        status: "active",
        source,
        current_period_start: now.toISOString(),
        current_period_end: end.toISOString(),
        external_reference_id: reference,
        updated_at: now.toISOString(),
      },
      { onConflict: "user_id" },
    );
    if (error) return json({ error: error.message }, 500);

    return json({ success: true, email, tier, expires: end.toISOString() });
  } catch (err) {
    return json({ error: (err as Error).message }, 500);
  }
});
