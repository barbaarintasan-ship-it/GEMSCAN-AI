// high-value-report-webhook
//
// Server-to-server webhook for the $5 High-Value Verification Report
// paywall (mobile/app/(app)/scan/verify.tsx's PaywallCard). This is the ONLY
// thing that ever marks a `high_value_report_purchases` row 'paid' — the
// mobile app can insert its own 'pending' row (migration 0010) but can never
// write 'paid' itself (RLS-enforced), matching the same client-owned-parent /
// service-role-only-write split used everywhere else in this schema.
//
// Once a purchase is confirmed paid, this function triggers the SAME single
// AI call verify-high-value used to make immediately on submit — that call
// is deferred until payment now, but nothing else about it changes. Reusing
// processVerification() (not duplicating its logic) keeps the "one AI call,
// never rerun" invariant intact.
//
// Same fail-closed convention as mobile-money-webhook: this endpoint REJECTS
// every request until a real payment gateway is selected and
// HIGH_VALUE_REPORT_GATEWAY_ENABLED=true is set alongside the shared secret.
// Flipping the secret alone does not open the endpoint. Until then, the $5
// report placeholder page (wordpress-plugin/) has nothing real to call this
// with, so this stays effectively dormant.
//
// Expected payload (adjust once a real gateway is chosen):
//   { purchaseId, status: 'success' | string, paymentMethod?: 'mobile_money' | 'card', referenceId?: string }
// Signature: HMAC-SHA256(rawBody, secret) hex, sent as X-Gateway-Signature —
// identical scheme to mobile-money-webhook, so both can eventually sit behind
// the same aggregator without a second signing scheme to maintain.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { corsHeaders } from "../_shared/cors.ts";
import { log, logError } from "../_shared/logger.ts";
import { processVerification } from "../verify-high-value/index.ts";

const supabaseAdmin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const GATEWAY_SHARED_SECRET = Deno.env.get("HIGH_VALUE_REPORT_GATEWAY_SECRET") ?? "";
const GATEWAY_ENABLED = Deno.env.get("HIGH_VALUE_REPORT_GATEWAY_ENABLED") === "true";

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

async function verifyGatewaySignature(req: Request, rawBody: string): Promise<boolean> {
  if (!GATEWAY_ENABLED || !GATEWAY_SHARED_SECRET) return false;
  const signature = req.headers.get("X-Gateway-Signature");
  if (!signature) return false;
  const expected = await hmacSha256Hex(GATEWAY_SHARED_SECRET, rawBody);
  return timingSafeEqual(signature.toLowerCase(), expected.toLowerCase());
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const rawBody = await req.text();
  if (!(await verifyGatewaySignature(req, rawBody))) {
    return jsonResponse({ error: "Signature verification failed" }, 400);
  }

  const payload = JSON.parse(rawBody);
  const { purchaseId, status, paymentMethod, referenceId } = payload;
  if (!purchaseId || !status) {
    return jsonResponse({ error: "Missing required fields" }, 400);
  }

  // Only a successful payment ever triggers the deferred AI call — anything
  // else (pending, failed, refunded, ...) is just logged.
  if (status !== "success") {
    return jsonResponse({ received: true });
  }

  try {
    // Atomic claim: the read-then-write this used to be (SELECT status, THEN
    // UPDATE) let two concurrent deliveries of the same webhook both read
    // "not yet paid" before either write landed, both proceeding to trigger
    // processVerification (an extra AI call, and a second verdict row).
    // A single UPDATE ... WHERE status != 'paid' can only ever succeed once
    // for a given row — Postgres serializes concurrent updates to the same
    // row — so exactly one concurrent caller gets a non-empty result back.
    const { data: updated, error: updateError } = await supabaseAdmin
      .from("high_value_report_purchases")
      .update({
        status: "paid",
        paid_at: new Date().toISOString(),
        payment_method: paymentMethod ?? null,
        external_reference_id: referenceId ?? null,
      })
      .eq("id", purchaseId)
      .neq("status", "paid")
      .select("id, verification_id")
      .maybeSingle();
    if (updateError) {
      return jsonResponse({ error: updateError.message }, 500);
    }

    if (!updated) {
      // Either the purchase doesn't exist, or it was already paid (this
      // exact webhook delivered twice) — either way, no second AI call.
      const { data: existing } = await supabaseAdmin
        .from("high_value_report_purchases")
        .select("id")
        .eq("id", purchaseId)
        .maybeSingle();
      if (!existing) {
        return jsonResponse({ error: "Purchase not found" }, 404);
      }
      return jsonResponse({ received: true, alreadyPaid: true });
    }

    const { data: verification, error: verificationError } = await supabaseAdmin
      .from("diamond_verifications")
      .select("id, scan_id, answers, image_paths, status")
      .eq("id", updated.verification_id)
      .maybeSingle();
    if (verificationError || !verification) {
      logError("high-value-report-webhook", new Error("Verification not found after payment"), { purchaseId });
      return jsonResponse({ received: true, warning: "verification not found" });
    }

    const { data: scan, error: scanError } = await supabaseAdmin
      .from("scans")
      .select("final_result, capture_location")
      .eq("id", verification.scan_id)
      .maybeSingle();
    const finalResult = (scan as { final_result?: Record<string, unknown> } | null)?.final_result;
    if (scanError || !scan || !finalResult || !finalResult.bestMatch) {
      logError("high-value-report-webhook", new Error("Original scan result not found"), { purchaseId });
      return jsonResponse({ received: true, warning: "scan result not found" });
    }

    // Same hallmark lookup as verify-high-value/index.ts's handleRequest —
    // duplicated deliberately rather than shared, matching that function's
    // own "zero code dependency on the primary identification pipeline"
    // convention for anything outside processVerification itself.
    const { data: hallmarkRow } = await supabaseAdmin
      .from("scan_ai_responses")
      .select("candidate_label, raw_response")
      .eq("scan_id", verification.scan_id)
      .eq("provider", "hallmark_ocr")
      .limit(1)
      .maybeSingle();
    const hallmarkRaw = (hallmarkRow as { raw_response?: { marks?: unknown } } | null)?.raw_response;
    const hallmark = hallmarkRow
      ? {
          matchedLabel: (hallmarkRow as { candidate_label?: string | null }).candidate_label ?? null,
          marks: Array.isArray(hallmarkRaw?.marks) ? (hallmarkRaw!.marks as string[]) : [],
        }
      : null;

    const verificationResponse = await processVerification({
      verificationId: verification.id as string,
      verification: verification as { scan_id: string; answers: unknown; image_paths: unknown; status: string },
      scan: scan as {
        final_result: Record<string, unknown>;
        capture_location: { lat: number; lng: number; label?: string } | null;
      },
      hallmark,
      serviceClient: supabaseAdmin,
    });

    if (verificationResponse.status !== 200) {
      const body = await verificationResponse.json().catch(() => null);
      logError("high-value-report-webhook", new Error(body?.error ?? "verify-high-value failed"), {
        purchaseId,
        verificationId: verification.id,
        status: verificationResponse.status,
      });
      return jsonResponse({ received: true, warning: "verdict generation failed" });
    }

    log("info", "high-value-report-webhook", "purchase paid, verdict generated", {
      purchaseId,
      verificationId: verification.id,
    });

    return jsonResponse({ received: true });
  } catch (err) {
    logError("high-value-report-webhook", err, { purchaseId });
    return jsonResponse({ error: (err as Error).message }, 500);
  }
});
