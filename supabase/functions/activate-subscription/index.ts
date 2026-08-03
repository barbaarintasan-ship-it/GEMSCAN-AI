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

// Constant-time string compare (avoids leaking the shared secret via timing),
// matching the pattern already used by the HMAC-verified webhook functions.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Sanity cap: no single grant should ever exceed this many credits — a
// legitimate credit pack tops out at 100 (migration 0005's credit_packages).
// Guards against a leaked ACTIVATION_SECRET being used to self-grant an
// effectively unlimited balance in one call.
const MAX_CREDITS_PER_GRANT = 1000;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const secret = Deno.env.get("ACTIVATION_SECRET");
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

    // Shared-secret auth — reject anything that doesn't present it.
    if (!secret || !timingSafeEqual(String(body.secret ?? ""), secret)) {
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

    // Grant purchased Deep Scan credits (website credit-pack purchase). These
    // are separate from the subscription allowance and roll over. Uses the
    // idempotent, server-only add_deep_scan_credits_idempotent() RPC
    // (migration 0014): given a reference id (the Stripe session id, or any
    // other stable per-purchase identifier the caller supplies), a retried or
    // replayed identical request is a no-op rather than granting credits
    // again — a plain retry-on-timeout from the caller (which WordPress/Stripe
    // both do) must never double-grant.
    if (action === "add_credits") {
      const credits = Math.floor(Number(body.credits ?? 0));
      if (!credits || credits <= 0) {
        return json({ error: "credits must be a positive integer" }, 400);
      }
      if (credits > MAX_CREDITS_PER_GRANT) {
        return json({ error: `credits must not exceed ${MAX_CREDITS_PER_GRANT} per grant` }, 400);
      }
      const reference = body.reference ? String(body.reference) : null;
      const { data: p } = await admin.from("profiles").select("id").eq("email", email).maybeSingle();
      if (!p) return json({ error: "no account found with that email" }, 404);
      const { data: newBalance, error: creditErr } = await admin.rpc("add_deep_scan_credits_idempotent", {
        p_user_id: p.id,
        p_credits: credits,
        p_reference: reference,
      });
      if (creditErr) return json({ error: creditErr.message }, 500);
      return json({ success: true, email, creditsAdded: credits, purchasedBalance: newBalance });
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
