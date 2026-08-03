// verify-gold-value
//
// Gold Verification Mode — a second, OPTIONAL stage offered after a scan
// whose result looks like it might be gold (native gold, gold-bearing rock,
// gold ore/concentrate, or suspicious jewelry). Never reruns or replaces the
// original scan (supabase/functions/orchestrate-scan) — it takes the
// already-persisted scan result plus a structured questionnaire the user
// filled in and any extra photos they captured, and makes exactly ONE
// additional AI call for a final, carefully-hedged verdict.
//
// This function is intentionally independent of orchestrate-scan AND of
// verify-high-value (the diamond equivalent): separate prompt (prompt.ts),
// separate single-provider (Gemini) call, no ensemble, no credits/
// subscription involvement, own tables — neither pipeline is ever at risk
// from this feature.
//
// Request:  POST, Authorization: Bearer <user JWT>, body: { verificationId: string }
// Response: { verificationId, verdict } (see types.ts GoldVerificationVerdict)
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { corsHeaders } from "../_shared/cors.ts";
import { log, logError } from "../_shared/logger.ts";
import { buildVerificationPrompt, parseVerificationResponse } from "./prompt.ts";
import type { GoldVerificationAnswers, GoldVerificationImagePaths, GoldVerificationVerdict } from "./types.ts";

const GEMINI_MODEL = Deno.env.get("GEMINI_MODEL") ?? "gemini-flash-latest";
const SIGNED_URL_TTL_SECONDS = 60 * 10;
// Evaluations per report purchase: the first, payment-triggered one plus up
// to 2 free re-runs after editing answers — not unlimited. Enforced
// atomically by reserve_gvr_evaluation_slot (migration 0013), not by reading
// then later incrementing a counter (that would be racy — see 0012's comment
// on the diamond equivalent for why).
const MAX_EVALUATIONS_PER_PURCHASE = 3;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Same base64 fetch as verify-high-value/index.ts — duplicated deliberately
// rather than imported, so this feature has zero code dependency on the
// primary identification pipeline or the diamond verification pipeline.
async function fetchImageAsBase64(url: string): Promise<{ base64: string; mimeType: string }> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch verification image (status ${res.status})`);
  const mimeType = res.headers.get("content-type") ?? "image/jpeg";
  const buffer = new Uint8Array(await res.arrayBuffer());
  let binary = "";
  for (let i = 0; i < buffer.length; i++) binary += String.fromCharCode(buffer[i]);
  return { base64: btoa(binary), mimeType };
}

export async function handleRequest(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonResponse({ error: "Missing Authorization header" }, 401);

    const requestBody = await req.json().catch(() => ({}));
    const verificationId = requestBody?.verificationId;
    if (!verificationId || typeof verificationId !== "string") {
      return jsonResponse({ error: "Missing or invalid verificationId" }, 400);
    }

    // Scoped to the caller's own JWT: RLS means every SELECT below can only
    // ever return rows this user owns — no separate authorization check is
    // needed, mirroring orchestrate-scan's pattern. If the verification isn't
    // this user's (or doesn't exist), these simply return null/not-found.
    const callerClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );

    const {
      data: { user },
      error: userError,
    } = await callerClient.auth.getUser();
    if (userError || !user) return jsonResponse({ error: "Invalid or expired session" }, 401);

    const { data: verification, error: verificationError } = await callerClient
      .from("gold_verifications")
      .select("id, scan_id, answers, image_paths, status")
      .eq("id", verificationId)
      .maybeSingle();
    if (verificationError || !verification) {
      return jsonResponse({ error: "Verification not found" }, 404);
    }

    // This is the only real enforcement of the $5 paywall — the app itself
    // only ever calls this endpoint once payment has gone through (either
    // the FIRST time via the payment webhook, or on a later free
    // re-evaluation after the user edits their answers), but that's just UI
    // behavior. Require an actual 'paid' gold_report_purchases row for this
    // verification so the endpoint can't be reached for a free evaluation by
    // calling it directly. This is a fast-fail convenience check only — the
    // real, race-safe cap enforcement is the atomic reservation inside
    // processVerification.
    const { data: purchase } = await callerClient
      .from("gold_report_purchases")
      .select("status")
      .eq("verification_id", verificationId)
      .maybeSingle();
    if (!purchase || purchase.status !== "paid") {
      return jsonResponse({ error: "Payment required for this report" }, 402);
    }

    const { data: scan, error: scanError } = await callerClient
      .from("scans")
      .select("final_result, capture_location")
      .eq("id", verification.scan_id)
      .maybeSingle();
    const finalResult = (scan as { final_result?: Record<string, unknown> } | null)?.final_result;
    if (scanError || !scan || !finalResult || !finalResult.bestMatch) {
      return jsonResponse({ error: "Original scan result not found" }, 404);
    }

    const { data: hallmarkRow } = await callerClient
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

    // service_role for everything from here on: signing verification photos,
    // calling the AI vendor, and writing the verdict (client-write-protected
    // by RLS — see migration 0013_gold_verification.sql).
    const serviceClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    return await processVerification({
      verificationId,
      verification: verification as VerificationRow,
      scan: scan as ScanRow,
      hallmark,
      serviceClient,
    });
  } catch (err) {
    logError("verify-gold-value", err, { stage: "handleRequest" });
    return jsonResponse({ error: (err as Error).message }, 500);
  }
}

// The Supabase Edge Runtime imports this file directly as the entry point
// (import.meta.main true); a test file importing handleRequest/
// processVerification instead does not start a listener — same convention as
// orchestrate-scan/index.ts and verify-high-value/index.ts.
if (import.meta.main) {
  Deno.serve(handleRequest);
}

type VerificationRow = {
  scan_id: string;
  answers: unknown;
  image_paths: unknown;
  status: string;
};
type ScanRow = {
  final_result: Record<string, unknown>;
  capture_location: { lat: number; lng: number; label?: string } | null;
};
type Hallmark = { matchedLabel: string | null; marks: string[] } | null;

// Ownership has already been proven by the RLS-scoped reads in handleRequest
// by the time this runs (same split as orchestrate-scan's handleRequest /
// processScan) — this is the part a test can exercise with a mocked
// serviceClient and fake data, without needing real Supabase auth.
export async function processVerification(params: {
  verificationId: string;
  verification: VerificationRow;
  scan: ScanRow;
  hallmark: Hallmark;
  serviceClient: SupabaseClient;
}): Promise<Response> {
  const { verificationId, verification, scan, hallmark, serviceClient } = params;
  const finalResult = scan.final_result;

  // Atomically check-and-reserve an evaluation slot BEFORE any AI work — one
  // guarded UPDATE (migration 0013) so two concurrent calls for the same
  // purchase can't both read "under the cap" and both slip through. A null
  // result means the purchase isn't paid, doesn't exist, or is already at
  // the cap.
  const { data: reservedCount, error: reserveError } = await serviceClient.rpc(
    "reserve_gvr_evaluation_slot",
    { p_verification_id: verificationId, p_max: MAX_EVALUATIONS_PER_PURCHASE },
  );
  if (reserveError) {
    logError("verify-gold-value", new Error(reserveError.message), { verificationId, stage: "reserve_slot" });
    return jsonResponse({ error: "Could not verify evaluation eligibility" }, 500);
  }
  if (reservedCount == null) {
    return jsonResponse(
      { error: `Evaluation limit reached (${MAX_EVALUATIONS_PER_PURCHASE} per report)` },
      429,
    );
  }
  // From here on, a slot is reserved — any early return due to a failure
  // below must release it first, so a transient failure never permanently
  // costs the user one of their 3 evaluations.
  async function releaseSlot() {
    const { error } = await serviceClient.rpc("release_gvr_evaluation_slot", {
      p_verification_id: verificationId,
    });
    if (error) {
      logError("verify-gold-value", new Error(error.message), { verificationId, stage: "release_slot" });
    }
  }

  const imagePaths = (verification.image_paths ?? {}) as GoldVerificationImagePaths;
  const imageLabels = Object.keys(imagePaths).filter(
    (k) => imagePaths[k as keyof GoldVerificationImagePaths],
  );

  // Everything from here through the Gemini call/parse can fail in ways
  // that must release the reserved slot (a thrown image-signing error, a
  // missing API key, a Gemini HTTP error, or a parse error) — wrapped in one
  // try/catch so no failure path can forget to release it.
  let verdict: GoldVerificationVerdict;
  try {
    const signedImages = await Promise.all(
      imageLabels.map(async (label) => {
        const path = imagePaths[label as keyof GoldVerificationImagePaths]!;
        const { data, error } = await serviceClient.storage
          .from("scan-images")
          .createSignedUrl(path, SIGNED_URL_TTL_SECONDS);
        if (error || !data) throw new Error(`Failed to sign verification image ${label}: ${error?.message}`);
        return { label, url: data.signedUrl };
      }),
    );

    const apiKey = Deno.env.get("GEMINI_API_KEY");
    if (!apiKey) {
      await releaseSlot();
      return jsonResponse({ error: "Verification AI is not configured" }, 500);
    }

    const prompt = buildVerificationPrompt({
      previousResult: {
        bestMatch: String(finalResult.bestMatch),
        confidenceScore: Number(finalResult.confidenceScore ?? 0),
        confidenceBand: (finalResult.confidenceBand as "low" | "medium" | "high") ?? "low",
        reasoning: (finalResult.reasoning as string | null) ?? null,
        alternatives: Array.isArray(finalResult.alternatives)
          ? (finalResult.alternatives as { label: string; weightedConfidence: number }[]).map((a) => ({
              label: a.label,
              confidence: a.weightedConfidence,
            }))
          : [],
      },
      hallmark,
      answers: (verification.answers ?? {}) as GoldVerificationAnswers,
      imageLabels: signedImages.map((i) => i.label),
      location: scan.capture_location ?? null,
    });

    const imageParts = await Promise.all(
      signedImages.map(async (img) => {
        const { base64, mimeType } = await fetchImageAsBase64(img.url);
        return { inline_data: { mime_type: mimeType, data: base64 } };
      }),
    );

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }, ...imageParts] }],
          generationConfig: { temperature: 0.2, responseMimeType: "application/json" },
        }),
      },
    );
    const geminiRaw = await geminiRes.json();
    if (!geminiRes.ok) {
      logError("verify-gold-value", new Error(geminiRaw?.error?.message ?? "Gemini API error"), {
        verificationId,
      });
      await releaseSlot();
      return jsonResponse({ error: "Verification AI request failed" }, 502);
    }

    const text = geminiRaw?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    try {
      verdict = parseVerificationResponse(text);
    } catch (err) {
      logError("verify-gold-value", err, { verificationId, stage: "parse" });
      await releaseSlot();
      return jsonResponse({ error: "Could not parse verification result" }, 502);
    }
  } catch (err) {
    logError("verify-gold-value", err, { verificationId, stage: "sign_or_call" });
    await releaseSlot();
    return jsonResponse({ error: (err as Error).message }, 500);
  }

  const { error: insertError } = await serviceClient.from("gold_verification_verdicts").insert([
    {
      verification_id: verificationId,
      scan_id: verification.scan_id,
      verdict,
    },
  ]);
  if (insertError) {
    logError("verify-gold-value", new Error(insertError.message), { verificationId, stage: "persist" });
    await releaseSlot();
  }

  await serviceClient.from("gold_verifications").update({ status: "completed" }).eq("id", verificationId);

  log("info", "verify-gold-value", "verification completed", {
    verificationId,
    scanId: verification.scan_id,
    recommendation: verdict.recommendation,
    confidence: verdict.confidence,
  });

  return jsonResponse({ verificationId, verdict });
}
