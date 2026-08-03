// verify-artifact-value
//
// Artifact Verification Mode — a second, OPTIONAL stage offered after a scan
// whose result looks like it might be a historical/archaeological artifact.
// Never reruns or replaces the original scan — it takes the already-persisted
// scan result plus a structured questionnaire and any extra photos, and makes
// exactly ONE additional AI call for a final, carefully-hedged verdict.
//
// Intentionally independent of orchestrate-scan AND of verify-high-value /
// verify-gold-value: separate prompt (prompt.ts), separate single-provider
// (Gemini) call, own tables — no pipeline is ever at risk from this feature.
//
// Request:  POST, Authorization: Bearer <user JWT>, body: { verificationId: string }
// Response: { verificationId, verdict } (see types.ts ArtifactVerificationVerdict)
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { corsHeaders } from "../_shared/cors.ts";
import { log, logError } from "../_shared/logger.ts";
import { buildVerificationPrompt, parseVerificationResponse } from "./prompt.ts";
import type {
  ArtifactVerificationAnswers,
  ArtifactVerificationImagePaths,
  ArtifactVerificationVerdict,
} from "./types.ts";

const GEMINI_MODEL = Deno.env.get("GEMINI_MODEL") ?? "gemini-flash-latest";
const SIGNED_URL_TTL_SECONDS = 60 * 10;
// Evaluations per report purchase: the first, payment-triggered one plus up
// to 2 free re-runs after editing answers — enforced atomically by
// reserve_avr_evaluation_slot (migration 0015).
const MAX_EVALUATIONS_PER_PURCHASE = 3;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Duplicated deliberately rather than imported, so this feature has zero code
// dependency on the primary identification pipeline or the other verifiers.
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
    // needed.
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
      .from("artifact_verifications")
      .select("id, scan_id, answers, image_paths, status")
      .eq("id", verificationId)
      .maybeSingle();
    if (verificationError || !verification) {
      return jsonResponse({ error: "Verification not found" }, 404);
    }

    // Fast-fail paywall check only — the real, race-safe cap enforcement is
    // the atomic reservation inside processVerification.
    const { data: purchase } = await callerClient
      .from("artifact_report_purchases")
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
    // by RLS — see migration 0015_artifact_verification.sql).
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
    logError("verify-artifact-value", err, { stage: "handleRequest" });
    return jsonResponse({ error: (err as Error).message }, 500);
  }
}

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

export async function processVerification(params: {
  verificationId: string;
  verification: VerificationRow;
  scan: ScanRow;
  hallmark: Hallmark;
  serviceClient: SupabaseClient;
}): Promise<Response> {
  const { verificationId, verification, scan, hallmark, serviceClient } = params;
  const finalResult = scan.final_result;

  // Atomically check-and-reserve an evaluation slot BEFORE any AI work.
  const { data: reservedCount, error: reserveError } = await serviceClient.rpc(
    "reserve_avr_evaluation_slot",
    { p_verification_id: verificationId, p_max: MAX_EVALUATIONS_PER_PURCHASE },
  );
  if (reserveError) {
    logError("verify-artifact-value", new Error(reserveError.message), { verificationId, stage: "reserve_slot" });
    return jsonResponse({ error: "Could not verify evaluation eligibility" }, 500);
  }
  if (reservedCount == null) {
    return jsonResponse(
      { error: `Evaluation limit reached (${MAX_EVALUATIONS_PER_PURCHASE} per report)` },
      429,
    );
  }
  // From here on a slot is reserved — any early return due to a failure below
  // must release it first, so a transient failure never permanently costs the
  // user one of their 3 evaluations.
  async function releaseSlot() {
    const { error } = await serviceClient.rpc("release_avr_evaluation_slot", {
      p_verification_id: verificationId,
    });
    if (error) {
      logError("verify-artifact-value", new Error(error.message), { verificationId, stage: "release_slot" });
    }
  }

  const imagePaths = (verification.image_paths ?? {}) as ArtifactVerificationImagePaths;
  const imageLabels = Object.keys(imagePaths).filter(
    (k) => imagePaths[k as keyof ArtifactVerificationImagePaths],
  );

  let verdict: ArtifactVerificationVerdict;
  try {
    const signedImages = await Promise.all(
      imageLabels.map(async (label) => {
        const path = imagePaths[label as keyof ArtifactVerificationImagePaths]!;
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
      answers: (verification.answers ?? {}) as ArtifactVerificationAnswers,
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
      logError("verify-artifact-value", new Error(geminiRaw?.error?.message ?? "Gemini API error"), {
        verificationId,
      });
      await releaseSlot();
      return jsonResponse({ error: "Verification AI request failed" }, 502);
    }

    const text = geminiRaw?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    try {
      verdict = parseVerificationResponse(text);
    } catch (err) {
      logError("verify-artifact-value", err, { verificationId, stage: "parse" });
      await releaseSlot();
      return jsonResponse({ error: "Could not parse verification result" }, 502);
    }
  } catch (err) {
    logError("verify-artifact-value", err, { verificationId, stage: "sign_or_call" });
    await releaseSlot();
    return jsonResponse({ error: (err as Error).message }, 500);
  }

  const { error: insertError } = await serviceClient.from("artifact_verification_verdicts").insert([
    {
      verification_id: verificationId,
      scan_id: verification.scan_id,
      verdict,
    },
  ]);
  if (insertError) {
    logError("verify-artifact-value", new Error(insertError.message), { verificationId, stage: "persist" });
    await releaseSlot();
  }

  await serviceClient.from("artifact_verifications").update({ status: "completed" }).eq("id", verificationId);

  log("info", "verify-artifact-value", "verification completed", {
    verificationId,
    scanId: verification.scan_id,
    recommendation: verdict.recommendation,
    confidence: verdict.confidence,
  });

  return jsonResponse({ verificationId, verdict });
}
