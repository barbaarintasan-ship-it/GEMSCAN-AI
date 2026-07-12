// orchestrate-scan
//
// The AI Scan Pipeline's Stage 4-7 orchestrator. Called by the mobile app
// once it has (Stage 1) captured and quality-validated every angle, (Stage 2)
// run on-device detection/crop, (Stage 3) enhanced the images, and uploaded
// the results into the `scan-images` Storage bucket plus rows in `scans` /
// `scan_images` (owned by the calling user, enforced by RLS — see migration
// 0002_scan_pipeline.sql).
//
// This function itself:
//   1. Verifies the caller owns the scan (via an anon+JWT-scoped client, so
//      RLS does the authorization — no manual ownership check needed).
//   2. Fans out to every applicable provider in `providerRegistry.ts` in
//      parallel (Stage 4), each wrapped in a timeout so one slow/down vendor
//      can't stall the whole scan (a lightweight circuit breaker per the
//      scalability notes in 04-Technical-Architecture-Database-Security.md).
//   3. Persists every provider's raw response to `scan_ai_responses`
//      (service_role only — the client can never write these).
//   4. Runs the weighted-confidence ensemble (Stage 5) and persists the
//      ranked result to `scan_candidates` + updates `scans` (Stage 6).
//   5. Returns the same final result to the caller so the mobile app can
//      render it immediately without a second round-trip.
//
// Request:  POST, Authorization: Bearer <user JWT>, body: { scanId: string }
// Response: { scanId, status, finalResult, candidates } (see ensemble.ts)

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { corsHeaders } from "../_shared/cors.ts";
import { featuresForTier } from "../_shared/entitlements.ts";
import { providerRegistry } from "./providers/providerRegistry.ts";
import type { ProviderInput, ProviderResult, VisionProvider } from "./providers/types.ts";
import { runEnsemble } from "./ensemble.ts";

const PROVIDER_TIMEOUT_MS = 25_000;
const SIGNED_URL_TTL_SECONDS = 60 * 10; // long enough for every provider call

type ScanRow = { id: string; specimen_category: string | null; capture_location: unknown };
type ImageRow = {
  angle: string;
  original_storage_path: string;
  processed_storage_path: string | null;
};

export async function handleRequest(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return jsonResponse({ error: "Missing Authorization header" }, 401);
    }

    const { scanId } = await req.json().catch(() => ({}));
    if (!scanId || typeof scanId !== "string") {
      return jsonResponse({ error: "Missing or invalid scanId" }, 400);
    }

    // Scoped to the caller's own JWT: RLS means the SELECT below can only
    // ever return this scan if the caller owns it — no separate authorization
    // check is needed here, mirroring verify-subscription's pattern.
    const callerClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );

    const {
      data: { user },
      error: userError,
    } = await callerClient.auth.getUser();
    if (userError || !user) {
      return jsonResponse({ error: "Invalid or expired session" }, 401);
    }

    const { data: scan, error: scanError } = await callerClient
      .from("scans")
      .select("id, specimen_category, capture_location, status")
      .eq("id", scanId)
      .maybeSingle();
    if (scanError || !scan) {
      return jsonResponse({ error: "Scan not found" }, 404);
    }

    const { data: images, error: imagesError } = await callerClient
      .from("scan_images")
      .select("angle, original_storage_path, processed_storage_path")
      .eq("scan_id", scanId);
    if (imagesError || !images || images.length === 0) {
      return jsonResponse({ error: "No images found for this scan" }, 400);
    }

    // Entitlement is re-derived and enforced HERE, server-side, at scan time —
    // not just read by the app for display. This is what actually makes the
    // free-tier daily limit and the "Deep Scan" premium ensemble gate real
    // product restrictions rather than UI suggestions.
    const { data: subscription } = await callerClient
      .from("subscriptions")
      .select("tier, status")
      .eq("user_id", user.id)
      .maybeSingle();
    const tier = subscription?.status === "active" ? subscription.tier : "free";
    const features = featuresForTier(tier);

    if (features.dailyScanLimit !== null) {
      const startOfToday = new Date();
      startOfToday.setUTCHours(0, 0, 0, 0);
      const { count } = await callerClient
        .from("scans")
        .select("id", { count: "exact", head: true })
        .eq("user_id", user.id)
        .neq("status", "failed")
        .gte("created_at", startOfToday.toISOString());
      if ((count ?? 0) > features.dailyScanLimit) {
        return jsonResponse(
          {
            error: "Daily scan limit reached for the free tier.",
            dailyScanLimit: features.dailyScanLimit,
          },
          403,
        );
      }
    }

    // service_role client for everything from here on: signed URL generation
    // (works regardless of the private bucket's RLS) and every write to the
    // AI-result tables, which have no client-write policy at all by design.
    const serviceClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    try {
      return await processScan({
        scanId,
        scan,
        images,
        req,
        serviceClient,
        ensembleScansEnabled: features.ensembleScans,
      });
    } catch (err) {
      // Best-effort: leave a clear "failed" record rather than an orphaned
      // scan stuck in "processing" forever if something throws mid-pipeline.
      await serviceClient
        .from("scans")
        .update({ status: "failed" })
        .eq("id", scanId)
        .then(
          () => {},
          () => {},
        );
      return jsonResponse({ error: (err as Error).message }, 500);
    }
  } catch (err) {
    return jsonResponse({ error: (err as Error).message }, 500);
  }
}

// The Supabase Edge Runtime imports this file directly as the entry point, in
// which case `import.meta.main` is true and we bind the HTTP server. When
// this module is instead imported by a test file, `import.meta.main` is
// false, so tests can import `processScan`/`handleRequest` without starting a
// listener.
if (import.meta.main) {
  Deno.serve(handleRequest);
}

export async function processScan(params: {
  scanId: string;
  scan: ScanRow;
  images: ImageRow[];
  req: Request;
  serviceClient: SupabaseClient;
  ensembleScansEnabled: boolean;
  // Optional override of the real provider registry, so tests can exercise
  // the full fan-out/timeout/persist/ensemble flow with fake providers
  // instead of hitting real AI vendor APIs.
  providers?: VisionProvider[];
}): Promise<Response> {
  const { scanId, scan, images, req, serviceClient, ensembleScansEnabled, providers } = params;

  const processingStartedAt = new Date();
  await serviceClient
    .from("scans")
    .update({ status: "processing", processing_started_at: processingStartedAt.toISOString() })
    .eq("id", scanId);

  const signedImages = await Promise.all(
    images.map(async (img) => {
      const path = img.processed_storage_path ?? img.original_storage_path;
      const { data, error } = await serviceClient.storage
        .from("scan-images")
        .createSignedUrl(path, SIGNED_URL_TTL_SECONDS);
      if (error || !data) {
        throw new Error(`Failed to sign URL for ${path}: ${error?.message}`);
      }
      return { angle: img.angle, url: data.signedUrl };
    }),
  );

  // The client is expected to pass through its Stage 2 on-device hint in the
  // request body too — accept it optionally without requiring it.
  const requestBody = await req.clone().json().catch(() => ({}));
  const onDeviceHint = requestBody?.onDeviceHint ?? null;

  const input: ProviderInput = {
    scanId,
    images: signedImages,
    specimenCategory: scan.specimen_category,
    onDeviceHint,
    location: (scan.capture_location as ProviderInput["location"]) ?? null,
    serviceClient,
  };

  const applicableProviders = (providers ?? providerRegistry).filter(
    (p) => p.isApplicable(input) && (!p.requiresEnsembleTier || ensembleScansEnabled),
  );

  const results: ProviderResult[] = await Promise.all(
    applicableProviders.map((provider) => withTimeout(provider, input)),
  );

  // Stage 7 (partial): persist every raw provider response, including
  // failures/timeouts, before computing the ensemble — so the audit trail
  // exists even if something goes wrong in the ensemble step itself.
  if (results.length > 0) {
    await serviceClient.from("scan_ai_responses").insert(
      results.map((r) => ({
        scan_id: scanId,
        provider: r.provider,
        candidate_label: r.candidate?.label ?? null,
        confidence: r.candidate?.confidence ?? null,
        reasoning: r.reasoning || null,
        alternatives: r.alternatives,
        raw_response: r.raw ?? null,
        latency_ms: r.latencyMs,
        error: r.error ?? null,
      })),
    );
  }

  const weightByProvider = new Map(applicableProviders.map((p) => [p.name, p.baseWeight]));
  const ensemble = runEnsemble(results, weightByProvider);

  if (ensemble.candidates.length > 0) {
    await serviceClient.from("scan_candidates").insert(
      ensemble.candidates.map((c) => ({
        scan_id: scanId,
        rank: c.rank,
        label: c.label,
        weighted_confidence: c.weightedConfidence,
        confidence_band: c.confidenceBand,
        rationale: c.rationale,
        rejected_reason: c.rejectedReason,
      })),
    );
  }

  const processingCompletedAt = new Date();
  const totalDurationMs = processingCompletedAt.getTime() - processingStartedAt.getTime();

  const finalResult = {
    bestMatch: ensemble.candidates[0]?.label ?? null,
    confidenceScore: ensemble.candidates[0]?.weightedConfidence ?? 0,
    confidenceBand: ensemble.candidates[0]?.confidenceBand ?? "low",
    reasoning: ensemble.candidates[0]?.rationale ?? null,
    alternatives: ensemble.candidates.slice(1),
    insufficientConfidence: ensemble.insufficientConfidence,
    message: ensemble.message,
    suggestions: ensemble.suggestions,
  };

  await serviceClient
    .from("scans")
    .update({
      status: "completed",
      final_result: finalResult,
      confidence_band: ensemble.candidates[0]?.confidenceBand ?? null,
      processing_completed_at: processingCompletedAt.toISOString(),
      total_duration_ms: totalDurationMs,
    })
    .eq("id", scanId);

  return jsonResponse({
    scanId,
    status: "completed",
    finalResult,
    candidates: ensemble.candidates,
  });
}

// Lightweight per-provider circuit breaker: a single slow/down vendor times
// out into an "abstain with error" result rather than hanging the whole scan.
async function withTimeout(
  provider: { name: string; identify: (input: ProviderInput) => Promise<ProviderResult> },
  input: ProviderInput,
): Promise<ProviderResult> {
  const start = Date.now();
  const timeout = new Promise<ProviderResult>((resolve) =>
    setTimeout(
      () =>
        resolve({
          provider: provider.name,
          candidate: null,
          alternatives: [],
          reasoning: "",
          latencyMs: Date.now() - start,
          error: `Timed out after ${PROVIDER_TIMEOUT_MS}ms`,
        }),
      PROVIDER_TIMEOUT_MS,
    ),
  );

  try {
    return await Promise.race([provider.identify(input), timeout]);
  } catch (err) {
    return {
      provider: provider.name,
      candidate: null,
      alternatives: [],
      reasoning: "",
      latencyMs: Date.now() - start,
      error: (err as Error).message,
    };
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
