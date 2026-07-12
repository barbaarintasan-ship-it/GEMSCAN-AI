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
// table via the service_role client. It is a template — replace the
// signature-verification block with the chosen gateway's actual scheme
// once a vendor is selected.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { corsHeaders } from "../_shared/cors.ts";
import { logError } from "../_shared/logger.ts";

const supabaseAdmin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const GATEWAY_SHARED_SECRET = Deno.env.get("MOBILE_MONEY_GATEWAY_SECRET")!;

function verifyGatewaySignature(req: Request, _rawBody: string): boolean {
  // PLACEHOLDER — replace with the real gateway's HMAC/signature scheme,
  // which will need the raw request body (kept in the signature above,
  // hence prefixed `_rawBody` rather than dropped) to compute/verify an
  // HMAC digest. Never process a payment event without verifying it
  // actually came from the gateway; an unauthenticated endpoint here would
  // let anyone grant themselves a subscription for free.
  const signature = req.headers.get("X-Gateway-Signature");
  return Boolean(signature && GATEWAY_SHARED_SECRET && signature.length > 0);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const rawBody = await req.text();

  if (!verifyGatewaySignature(req, rawBody)) {
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
