// mobile-money-webhook
//
// Generic inbound webhook for Somali mobile money rails (EVC Plus, Zaad,
// Sahal, eDahab) processed via a licensed payment gateway/aggregator on the
// website side (e.g. a WaafiPay-style integration — see 05-Monetization-
// Legal-Payments.md, which flags that the specific gateway vendor still
// needs a dedicated fintech/legal review before going live).
//
// This function follows the exact same contract as stripe-webhook: verify
// the request came from the real gateway, then upsert the subscriptions
// table via the service_role client.
//
// Signature verification is real HMAC-SHA256(rawBody, secret) — NOT a
// placeholder — but the endpoint stays fully FAIL-CLOSED (rejects every
// request, signed or not) until MOBILE_MONEY_GATEWAY_ENABLED=true is set,
// since no gateway vendor has been selected yet (see 05-Monetization-
// Legal-Payments.md). If the eventual gateway uses a different signing
// scheme than a flat HMAC of the raw body, adjust verifyGatewaySignature()
// accordingly before enabling.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { corsHeaders } from "../_shared/cors.ts";
import { logError } from "../_shared/logger.ts";

const supabaseAdmin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const GATEWAY_SHARED_SECRET = Deno.env.get("MOBILE_MONEY_GATEWAY_SECRET") ?? "";
// Explicit kill-switch: this endpoint stays FAIL-CLOSED (rejects everything)
// until a real gateway is selected and MOBILE_MONEY_GATEWAY_ENABLED=true is
// set alongside the secret. This prevents the "placeholder that quietly
// accepts any request" trap — flipping the secret alone is not enough to
// open the endpoint.
const GATEWAY_ENABLED = Deno.env.get("MOBILE_MONEY_GATEWAY_ENABLED") === "true";

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Constant-time string compare (avoids leaking the secret via timing).
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return toHex(sig);
}

// Verifies an HMAC-SHA256(rawBody, secret) hex digest sent as
// X-Gateway-Signature. This is the standard scheme (Stripe, most WaafiPay-
// style aggregators); adjust the digest computation here only if the chosen
// gateway uses a different scheme (e.g. a timestamp prefix like Stripe's
// `t=...,v1=...`). Never process a payment event without verifying it
// actually came from the gateway — an unauthenticated endpoint here would
// let anyone grant themselves a subscription for free.
async function verifyGatewaySignature(req: Request, rawBody: string): Promise<boolean> {
  if (!GATEWAY_ENABLED || !GATEWAY_SHARED_SECRET) return false;
  const signature = req.headers.get("X-Gateway-Signature");
  if (!signature) return false;
  const expected = await hmacSha256Hex(GATEWAY_SHARED_SECRET, rawBody);
  return timingSafeEqual(signature.toLowerCase(), expected.toLowerCase());
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const rawBody = await req.text();

  if (!(await verifyGatewaySignature(req, rawBody))) {
    return new Response("Signature verification failed", { status: 400 });
  }

  const payload = JSON.parse(rawBody);
  // Expected shape (adjust to the real gateway's payload once selected):
  // { userId, provider: 'evc_plus' | 'zaad' | 'sahal' | 'edahab', plan, referenceId, status }
  const { userId, provider, plan, referenceId, status } = payload;

  if (!userId || !provider || !plan || !referenceId) {
    return new Response(JSON.stringify({ error: "Missing required fields" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const sourceMap: Record<string, string> = {
    evc_plus: "mobile_money_evc",
    zaad: "mobile_money_zaad",
    sahal: "mobile_money_sahal",
    edahab: "mobile_money_edahab",
  };

  try {
    // Idempotency: a real gateway retries a webhook delivery on any timeout,
    // and referenceId identifies one real transaction — if we've already
    // recorded this exact reference, don't re-activate (a subscription
    // upsert is naturally idempotent for the SAME plan, but a replay could
    // otherwise still be used to silently downgrade/upgrade a plan by
    // resending an old signed payload with different claimed values).
    if (status === "success") {
      const { data: already } = await supabaseAdmin
        .from("payment_events")
        .select("id")
        .eq("source", provider)
        .eq("external_reference_id", referenceId)
        .eq("event_type", "success")
        .maybeSingle();
      if (already) {
        return new Response(JSON.stringify({ received: true, alreadyProcessed: true }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    if (status === "success") {
      const now = new Date();
      const oneYearOut = new Date(now);
      oneYearOut.setFullYear(now.getFullYear() + 1);

      const { error } = await supabaseAdmin.from("subscriptions").upsert(
        {
          user_id: userId,
          tier: plan === "lifetime" ? "lifetime" : "premium",
          status: "active",
          source: sourceMap[provider] ?? provider,
          external_reference_id: referenceId,
          current_period_start: now.toISOString(),
          current_period_end: plan === "lifetime" ? null : oneYearOut.toISOString(),
          updated_at: now.toISOString(),
        },
        { onConflict: "user_id" },
      );
      if (error) throw error;
    }

    await supabaseAdmin.from("payment_events").insert({
      source: provider,
      event_type: status,
      external_reference_id: referenceId,
      user_id: userId,
      payload,
    });

    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    logError("mobile-money-webhook", err);
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
