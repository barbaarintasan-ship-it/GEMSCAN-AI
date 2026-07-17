// verify-subscription
//
// THE ONLY entitlement endpoint the mobile app is allowed to call.
// It never accepts payment details, never talks to Stripe/PayPal/mobile-money
// gateways, and never mutates the subscriptions table — it is strictly
// read-only, scoped to the calling user's own row via RLS (see migration
// 0001_init_auth_subscriptions.sql). This is what "the app only verifies
// subscription status" means in code, not just in the product doc.
//
// Request:  GET, Authorization: Bearer <user JWT>
// Response: { tier, status, current_period_end, features: { ... } }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { corsHeaders } from "../_shared/cors.ts";
import { logError } from "../_shared/logger.ts";
// Feature entitlements are derived server-side from `tier` in one shared
// place (also used by orchestrate-scan to enforce daily scan limits / gate
// the multi-model ensemble at scan time, not just to render a UI hint), so
// the mobile app never has to encode "what does premium unlock" logic
// itself — it just renders whatever the backend says is unlocked.
import {
  deepScanAllowanceFor,
  featuresForTier,
  isOwnerEmail,
  resolveEffectiveTier,
} from "../_shared/entitlements.ts";
import { getDeepScanStatus, periodStartFor } from "../_shared/deepScanCredits.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: "Missing Authorization header" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Client scoped to the caller's own JWT — RLS restricts the subsequent
    // query to the caller's own subscriptions row, no matter what. Even if
    // this function had a bug, it structurally cannot read another user's
    // entitlement or write to the table at all (no write call exists below).
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );

    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();

    if (userError || !user) {
      return new Response(JSON.stringify({ error: "Invalid or expired session" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: subscription, error: subError } = await supabase
      .from("subscriptions")
      .select("tier, status, current_period_end, current_period_start, source")
      .eq("user_id", user.id)
      .maybeSingle();

    if (subError) {
      return new Response(JSON.stringify({ error: subError.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Owner accounts are forced to "professional"; otherwise the active tier or
    // "free". Defensive default: if no row exists yet (shouldn't happen, the
    // signup trigger creates one), treat as free rather than failing closed on
    // paid features being blocked.
    const owner = isOwnerEmail(user.email);
    const tier = resolveEffectiveTier(user.email, subscription);

    // Deep Scan balance so the app can show "Deep Scan Credits: X/Y remaining".
    // Read with the caller's own JWT — RLS scopes scan_usage / deep_scan_credits
    // to this user's rows only. Fails soft to zeros so a hiccup never blocks the
    // subscription check.
    let deepScan = { allowance: 0, used: 0, purchased: 0, remaining: 0 };
    try {
      const allowance = deepScanAllowanceFor(user.email, tier);
      const status = await getDeepScanStatus(
        supabase,
        user.id,
        allowance,
        periodStartFor(subscription),
      );
      deepScan = {
        allowance: status.allowance,
        used: status.used,
        purchased: status.purchased,
        remaining: status.remaining,
      };
    } catch (_e) {
      /* leave zeros */
    }

    return new Response(
      JSON.stringify({
        tier,
        status: owner ? "active" : (subscription?.status ?? "active"),
        currentPeriodEnd: owner ? null : (subscription?.current_period_end ?? null),
        source: owner ? "owner" : (subscription?.source ?? null),
        features: featuresForTier(tier),
        deepScan,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    logError("verify-subscription", err);
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
