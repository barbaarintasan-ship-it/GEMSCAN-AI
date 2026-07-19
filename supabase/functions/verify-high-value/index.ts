// verify-high-value
//
// Advanced Diamond Verification (High-Value Expert Workflow) — a second,
// OPTIONAL stage offered after a scan whose result looks like it might be a
// diamond-family/high-value gemstone. Never reruns or replaces the original
// scan (supabase/functions/orchestrate-scan) — it takes the already-persisted
// scan result plus a structured questionnaire the user filled in and any
// extra photos they captured, and makes exactly ONE additional AI call for a
// final, carefully-hedged expert verdict.
//
// This function is intentionally independent of orchestrate-scan: separate
// prompt (prompt.ts), separate single-provider (Gemini) call, no ensemble, no
// credits/subscription involvement — the primary identification pipeline is
// never at risk from this feature.
//
// Request:  POST, Authorization: Bearer <user JWT>, body: { verificationId: string }
// Response: { verificationId, verdict } (see types.ts VerificationVerdict)
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { corsHeaders } from "../_shared/cors.ts";
import { log, logError } from "../_shared/logger.ts";
import { buildVerificationPrompt, parseVerificationResponse } from "./prompt.ts";
import type { VerificationAnswers, VerificationImagePaths, VerificationVerdict } from "./types.ts";

const GEMINI_MODEL = Deno.env.get("GEMINI_MODEL") ?? "gemini-flash-latest";
const SIGNED_URL_TTL_SECONDS = 60 * 10;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Same base64 fetch as orchestrate-scan/providers/promptShared.ts's
// fetchImageAsBase64 — duplicated deliberately rather than imported, so this
// feature has zero code dependency on the primary identification pipeline.
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
      .from("diamond_verifications")
      .select("id, scan_id, answers, image_paths, status")
      .eq("id", verificationId)
      .maybeSingle();
    if (verificationError || !verification) {
      return jsonResponse({ error: "Verification not found" }, 404);
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
    // by RLS — see migration 0009_diamond_verification.sql).
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
    logError("verify-high-value", err, { stage: "handleRequest" });
    return jsonResponse({ error: (err as Error).message }, 500);
  }
}

// The Supabase Edge Runtime imports this file directly as the entry point
// (import.meta.main true); a test file importing handleRequest/
// processVerification instead does not start a listener — same convention as
// orchestrate-scan/index.ts.
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

  const imagePaths = (verification.image_paths ?? {}) as VerificationImagePaths;
  const imageLabels = Object.keys(imagePaths).filter(
    (k) => imagePaths[k as keyof VerificationImagePaths],
  );
  const signedImages = await Promise.all(
    imageLabels.map(async (label) => {
      const path = imagePaths[label as keyof VerificationImagePaths]!;
      const { data, error } = await serviceClient.storage
        .from("scan-images")
        .createSignedUrl(path, SIGNED_URL_TTL_SECONDS);
      if (error || !data) throw new Error(`Failed to sign verification image ${label}: ${error?.message}`);
      return { label, url: data.signedUrl };
    }),
  );

  const apiKey = Deno.env.get("GEMINI_API_KEY");
  if (!apiKey) return jsonResponse({ error: "Verification AI is not configured" }, 500);

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
    answers: (verification.answers ?? {}) as VerificationAnswers,
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
    logError("verify-high-value", new Error(geminiRaw?.error?.message ?? "Gemini API error"), {
      verificationId,
    });
    return jsonResponse({ error: "Verification AI request failed" }, 502);
  }

  const text = geminiRaw?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  let verdict: VerificationVerdict;
  try {
    verdict = parseVerificationResponse(text);
  } catch (err) {
    logError("verify-high-value", err, { verificationId, stage: "parse" });
    return jsonResponse({ error: "Could not parse verification result" }, 502);
  }

  const { error: insertError } = await serviceClient.from("diamond_verification_verdicts").insert([
    {
      verification_id: verificationId,
      scan_id: verification.scan_id,
      verdict,
    },
  ]);
  if (insertError) {
    logError("verify-high-value", new Error(insertError.message), { verificationId, stage: "persist" });
  }

  await serviceClient.from("diamond_verifications").update({ status: "completed" }).eq("id", verificationId);

  log("info", "verify-high-value", "verification completed", {
    verificationId,
    scanId: verification.scan_id,
    recommendation: verdict.recommendation,
    confidence: verdict.confidence,
  });

  return jsonResponse({ verificationId, verdict });
}
