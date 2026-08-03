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
import { log, logError } from "../_shared/logger.ts";
import { deepScanAllowanceFor, featuresForTier, resolveEffectiveTier } from "../_shared/entitlements.ts";
import {
  consumeDeepScan,
  getDeepScanStatus,
  periodStartFor,
  recordStandardScan,
} from "../_shared/deepScanCredits.ts";
import { providerRegistry } from "./providers/providerRegistry.ts";
import type { ProviderInput, ProviderResult, VisionProvider } from "./providers/types.ts";
import { runEnsemble } from "./ensemble.ts";
import { buildExplanations } from "./explanationSynthesis.ts";

// Was 25s, briefly dropped to 15s for perceived speed — but that shortening
// was never reconciled with Dual Explanation Modes, which grew each
// provider's required JSON response from ~4 small fields to ~30 (including a
// full expertExplanation object) and raised Claude's own max_tokens 512->1800
// to fit it. Generating that much structured output, across up to 8 images,
// routinely takes longer than 15s — so nearly every scan was timing out on
// every provider (a real production outage, not a perceived-speed win).
// Raised well above the original 25s to give the larger response room to
// complete; perceived speed is now handled by Progressive Results (live
// per-provider status in capture.tsx) rather than an artificially short
// deadline. A timed-out provider still simply abstains rather than blocking
// the scan (see withTimeout below).
const PROVIDER_TIMEOUT_MS = 45_000;
const SIGNED_URL_TTL_SECONDS = 60 * 10; // long enough for every provider call

// Auto Scan Lock threshold — the ensemble confidence at/above which the mobile
// Live Scan auto-locks and stops sending further cloud requests. Backend-owned
// and configurable (req: "threshold must be configurable from the backend")
// via the SCAN_AUTOLOCK_THRESHOLD env/secret, so it can be tuned without an app
// release. Returned on every response as `autoLockThreshold`; the app falls
// back to 0.95 if it's ever absent.
const DEFAULT_AUTOLOCK_THRESHOLD = 0.95;

function autoLockThreshold(): number {
  const raw = Deno.env.get("SCAN_AUTOLOCK_THRESHOLD");
  if (!raw) return DEFAULT_AUTOLOCK_THRESHOLD;
  const parsed = Number.parseFloat(raw);
  if (Number.isNaN(parsed)) return DEFAULT_AUTOLOCK_THRESHOLD;
  return Math.max(0, Math.min(1, parsed));
}

type ScanRow = { id: string; specimen_category: string | null; capture_location: unknown };
type ImageRow = {
  angle: string;
  original_storage_path: string;
  processed_storage_path: string | null;
  // Stage-1 client-side quality validation, already recorded at upload time
  // (see mobile/lib/scanUpload.ts). Used by the image-quality gate below.
  quality_score: number | null;
  quality_flags: { blurry?: boolean; lowLight?: boolean; overexposed?: boolean } | null;
};

// ── Image quality gate (Stage 1 enforcement) ────────────────────────────────
// An unusable photograph is the single largest source of inconsistent
// identifications: blur destroys texture, colour casts shift hue, and a
// specimen can then be read as one mineral today and another tomorrow. Below
// this score we STOP before spending any AI call (or Deep Scan credit) and ask
// for better photographs instead of guessing.
const MIN_IMAGE_QUALITY = 0.45;

export const POOR_IMAGE_QUALITY_MESSAGE =
  "These photos are not clear enough to identify the specimen reliably.";

/** Mean Stage-1 quality across images. Returns 1 (neutral) when unscored, so
 *  older clients that never sent a score are never penalised. */
export function meanImageQuality(images: Pick<ImageRow, "quality_score">[]): number {
  const scores = images
    .map((i) => i.quality_score)
    .filter((s): s is number => typeof s === "number" && Number.isFinite(s));
  if (scores.length === 0) return 1;
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  return Math.max(0, Math.min(1, mean));
}

/** Actionable, specific guidance derived from the recorded quality flags. */
export function imageQualitySuggestions(images: Pick<ImageRow, "quality_flags">[]): string[] {
  const flags = images.map((i) => i.quality_flags ?? {});
  const out: string[] = [];
  if (flags.some((f) => f.blurry)) {
    out.push("Hold the camera steady and tap to focus — the specimen is blurred.");
  }
  if (flags.some((f) => f.lowLight)) {
    out.push("Move into brighter, even light (daylight works best) — the photo is too dark.");
  }
  if (flags.some((f) => f.overexposed)) {
    out.push("Avoid direct flash and glare — highlights are washing out the surface.");
  }
  if (out.length === 0) {
    out.push("Retake the photos closer, in focus, filling more of the frame.");
  }
  out.push("A sharp macro close-up of a fresh, unweathered surface helps the most.");
  return out;
}

export async function handleRequest(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return jsonResponse({ error: "Missing Authorization header" }, 401);
    }

    // Parse the request body exactly ONCE. A Request body is a single-use
    // stream: reading it here and then AGAIN later (the old code did
    // `req.clone().json()` inside processScan) throws "Body already consumed",
    // which deterministically failed EVERY real scan the moment it went through
    // this handler. Both `scanId` and the optional Stage-2 `onDeviceHint` are
    // therefore extracted here and threaded through explicitly.
    const requestBody = await req.json().catch(() => ({}));
    const scanId = requestBody?.scanId;
    const onDeviceHint = (requestBody?.onDeviceHint ?? null) as ProviderInput["onDeviceHint"];
    // Scan type decides cost: "standard" = one cheap model, "deep" = the full
    // 3-AI ensemble (metered with credits). Default to standard so a missing/
    // malformed field can NEVER accidentally trigger the expensive path.
    const scanType: "standard" | "deep" = requestBody?.scanType === "deep" ? "deep" : "standard";
    // Dual Explanation Modes preference for this scan — defaults to "simple"
    // for any missing/malformed value so it can never fail a scan.
    const explanationStyle: "simple" | "expert" =
      requestBody?.explanationStyle === "expert" ? "expert" : "simple";
    // The app's current display language — controls what language the AI
    // writes its narrative explanation text in (see ProviderInput.lang).
    // Defaults to English for any missing/malformed value.
    const lang: "en" | "so" = requestBody?.lang === "so" ? "so" : "en";
    if (!scanId || typeof scanId !== "string") {
      return jsonResponse({ error: "Missing or invalid scanId" }, 400);
    }
    log("info", "orchestrate-scan", "scan requested", {
      scanId,
      scanType,
      explanationStyle,
      lang,
      hasOnDeviceHint: onDeviceHint !== null,
    });

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
      .select("angle, original_storage_path, processed_storage_path, quality_score, quality_flags")
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
      .select("tier, status, current_period_start")
      .eq("user_id", user.id)
      .maybeSingle();
    // Owner accounts resolve to "professional" regardless of any subscriptions
    // row; everyone else gets their active tier or "free".
    const tier = resolveEffectiveTier(user.email, subscription);
    const features = featuresForTier(tier);

    // service_role client for everything from here on: usage/credit writes,
    // signed URLs, and the AI-result tables (no client-write policy by design).
    const serviceClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // ── Image quality gate (Stage 1 enforcement) ───────────────────────────
    // Runs BEFORE any credit spend and before any AI call: a scan that cannot
    // produce a trustworthy answer must not cost the user a Deep Scan credit,
    // and must never be guessed at. Returns the insufficient-confidence shape
    // the app already renders, plus specific guidance on what to fix.
    const gateQuality = meanImageQuality(images as ImageRow[]);
    if (gateQuality < MIN_IMAGE_QUALITY) {
      log("info", "orchestrate-scan", "image quality gate stopped scan", {
        scanId,
        stage: "image_quality_gate",
        quality: gateQuality,
      });
      const finalResult = {
        bestMatch: null,
        confidenceScore: 0,
        confidenceBand: "low" as const,
        reasoning: null,
        alternatives: [],
        insufficientConfidence: true,
        message: POOR_IMAGE_QUALITY_MESSAGE,
        suggestions: imageQualitySuggestions(images as ImageRow[]),
        explanationStyle,
        simpleExplanation: null,
        expertExplanation: null,
        imageObservations: null,
        warnings: null,
        recommendations: null,
      };
      await serviceClient
        .from("scans")
        .update({ status: "completed", final_result: finalResult, confidence_band: "low" })
        .eq("id", scanId);
      return jsonResponse({
        scanId,
        status: "completed",
        finalResult,
        candidates: [],
        autoLockThreshold: autoLockThreshold(),
      });
    }

    // Entitlement + cost gate, enforced HERE (server-side), before any AI call.
    let ensembleScansEnabled = false;

    if (scanType === "deep") {
      // Deep Scan = expensive ensemble → must be paid for with a credit.
      const allowance = deepScanAllowanceFor(user.email, tier);
      const periodStartISO = periodStartFor(subscription);
      const status = await getDeepScanStatus(serviceClient, user.id, allowance, periodStartISO);

      if (status.remaining <= 0) {
        return jsonResponse(
          {
            error: "Your Deep Scan credits are finished.",
            code: "deep_credits_exhausted",
            deepScan: { allowance: status.allowance, used: status.used, purchased: status.purchased, remaining: 0 },
          },
          402, // Payment Required.
        );
      }

      // Pre-authorize: consume the credit BEFORE the expensive AI calls so a
      // Deep Scan can never run without being paid for.
      const source = await consumeDeepScan(serviceClient, {
        userId: user.id,
        scanId,
        plan: tier,
        periodStartISO,
        status,
        aiModels: ["gemini", "openai", "claude"],
      });
      if (!source) {
        return jsonResponse(
          { error: "Your Deep Scan credits are finished.", code: "deep_credits_exhausted" },
          402,
        );
      }
      log("info", "orchestrate-scan", "deep scan authorized", { scanId, source, remaining: status.remaining - 1 });
      ensembleScansEnabled = true;
    } else {
      // Standard Scan = one cheap model. No credit; a daily cap only guards
      // against abuse.
      if (features.standardScanDailyLimit !== null) {
        const startOfToday = new Date();
        startOfToday.setUTCHours(0, 0, 0, 0);
        const { count } = await serviceClient
          .from("scan_usage")
          .select("id", { count: "exact", head: true })
          .eq("user_id", user.id)
          .eq("scan_type", "standard")
          .gte("created_at", startOfToday.toISOString());
        if ((count ?? 0) >= features.standardScanDailyLimit) {
          return jsonResponse(
            {
              error: "Daily Standard Scan limit reached. Please try again tomorrow.",
              code: "standard_limit_reached",
              standardScanDailyLimit: features.standardScanDailyLimit,
            },
            429, // Too Many Requests.
          );
        }
      }
      await recordStandardScan(serviceClient, {
        userId: user.id,
        scanId,
        plan: tier,
        aiModels: ["gemini"],
      });
      ensembleScansEnabled = false;
    }

    try {
      return await processScan({
        scanId,
        scan,
        images,
        onDeviceHint,
        explanationStyle,
        lang,
        serviceClient,
        ensembleScansEnabled,
      });
    } catch (err) {
      logError("orchestrate-scan", err, { scanId, stage: "processScan" });
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
    logError("orchestrate-scan", err, { stage: "handleRequest" });
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
  // Stage-2 on-device hint, already parsed from the request body by the caller
  // (handleRequest). Passed as a value — NOT re-read from the request — because
  // the body stream has already been consumed by the time we get here.
  onDeviceHint: ProviderInput["onDeviceHint"];
  // Dual Explanation Modes preference for this scan. Defaults to "simple" in
  // handleRequest for any missing/malformed value; threaded through the same
  // way onDeviceHint is.
  explanationStyle?: "simple" | "expert";
  // The app's display language for this scan. Defaults to "en" in
  // handleRequest for any missing/malformed value; threaded through the same
  // way onDeviceHint/explanationStyle are.
  lang?: "en" | "so";
  serviceClient: SupabaseClient;
  ensembleScansEnabled: boolean;
  // Optional override of the real provider registry, so tests can exercise
  // the full fan-out/timeout/persist/ensemble flow with fake providers
  // instead of hitting real AI vendor APIs.
  providers?: VisionProvider[];
}): Promise<Response> {
  const {
    scanId,
    scan,
    images,
    onDeviceHint,
    explanationStyle = "simple",
    lang = "en",
    serviceClient,
    ensembleScansEnabled,
    providers,
  } = params;

  const processingStartedAt = new Date();
  await serviceClient
    .from("scans")
    .update({ status: "processing", processing_started_at: processingStartedAt.toISOString() })
    .eq("id", scanId);

  // Stage 4a: sign a short-lived URL per image so providers can fetch the bytes.
  const signStart = Date.now();
  const signedImages = await Promise.all(
    images.map(async (img) => {
      const path = img.processed_storage_path ?? img.original_storage_path;
      const { data, error } = await serviceClient.storage
        .from("scan-images")
        .createSignedUrl(path, SIGNED_URL_TTL_SECONDS);
      if (error || !data) {
        log("error", "orchestrate-scan", "signed URL generation failed", {
          scanId,
          stage: "sign_url",
          path,
          reason: error?.message,
        });
        throw new Error(`Failed to sign URL for ${path}: ${error?.message}`);
      }
      return { angle: img.angle, url: data.signedUrl };
    }),
  );
  log("info", "orchestrate-scan", "images signed", {
    scanId,
    stage: "sign_url",
    imageCount: signedImages.length,
    durationMs: Date.now() - signStart,
  });

  const input: ProviderInput = {
    scanId,
    images: signedImages,
    specimenCategory: scan.specimen_category,
    onDeviceHint,
    location: (scan.capture_location as ProviderInput["location"]) ?? null,
    explanationStyle,
    lang,
    serviceClient,
  };

  const applicableProviders = (providers ?? providerRegistry).filter(
    (p) => p.isApplicable(input) && (!p.requiresEnsembleTier || ensembleScansEnabled),
  );
  log("info", "orchestrate-scan", "providers selected", {
    scanId,
    stage: "providers",
    providers: applicableProviders.map((p) => p.name),
    ensembleScansEnabled,
  });

  // Auto Scan Lock makes this endpoint re-entrant: the Live Scan may call it
  // multiple times against the SAME scanId as it progressively collects more
  // evidence, until confidence crosses the auto-lock threshold. Clear any prior
  // AI rows for this scan BEFORE the fan-out below (not after) so a
  // re-evaluation replaces rather than duplicates previous responses, and so
  // the progressive inserts that follow don't get wiped out immediately after
  // landing. A first-time scan simply deletes zero rows.
  await Promise.all([
    serviceClient.from("scan_ai_responses").delete().eq("scan_id", scanId),
    serviceClient.from("scan_candidates").delete().eq("scan_id", scanId),
  ]);

  // Stage 7 (partial): persist — and log — each provider's raw response the
  // moment ITS OWN call settles, not after every provider finishes. This is
  // what lets the mobile app poll scan_ai_responses mid-scan for real
  // progressive results (see capture.tsx) instead of a blank wait, while every
  // result is still gathered into `results` for the ensemble step below,
  // completely unchanged. Grep deployed logs by `"stage":"provider_result"`.
  const results: ProviderResult[] = await Promise.all(
    applicableProviders.map(async (provider) => {
      const result = await withTimeout(provider, input);
      log(result.error ? "warn" : "info", "orchestrate-scan", "provider result", {
        scanId,
        stage: "provider_result",
        provider: result.provider,
        identified: result.candidate !== null,
        label: result.candidate?.label ?? null,
        confidence: result.candidate?.confidence ?? null,
        latencyMs: result.latencyMs,
        reason: result.error ?? null,
      });
      await serviceClient.from("scan_ai_responses").insert([
        {
          scan_id: scanId,
          provider: result.provider,
          candidate_label: result.candidate?.label ?? null,
          confidence: result.candidate?.confidence ?? null,
          reasoning: result.reasoning || null,
          alternatives: result.alternatives,
          raw_response: result.raw ?? null,
          analysis: result.analysis ?? null,
          latency_ms: result.latencyMs,
          error: result.error ?? null,
        },
      ]);
      return result;
    }),
  );

  const weightByProvider = new Map(applicableProviders.map((p) => [p.name, p.baseWeight]));
  // Confidence is computed here, from evidence — provider agreement, candidate
  // separation and Stage-1 image quality — never taken from a model.
  const ensemble = runEnsemble(results, weightByProvider, meanImageQuality(images));

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

  // Dual Explanation Modes: pick whichever provider's already-generated
  // Simple/Expert write-up best represents the winning candidate. Purely
  // additive to finalResult — does not affect bestMatch/confidence/ranking.
  const explanations = buildExplanations(
    ensemble.candidates[0]?.label ?? null,
    results,
    weightByProvider,
  );

  // An unconfirmed identification must not be dressed up as one: when the
  // decision engine did not clear the acceptance threshold we withhold the
  // geological/gemological interpretation (origin, market, investment) and the
  // narrative that asserts the identity. The observations, the honest warnings
  // and the "what to do next" guidance are kept — those are exactly what the
  // user needs while the answer is still open.
  const unlocked = ensemble.interpretationUnlocked;
  const finalResult = {
    bestMatch: ensemble.insufficientConfidence ? null : ensemble.candidates[0]?.label ?? null,
    confidenceScore: ensemble.candidates[0]?.weightedConfidence ?? 0,
    confidenceBand: ensemble.candidates[0]?.confidenceBand ?? "low",
    reasoning: ensemble.candidates[0]?.rationale ?? null,
    // With no confirmed match, every candidate is presented as a possibility.
    alternatives: ensemble.insufficientConfidence
      ? ensemble.candidates
      : ensemble.candidates.slice(1),
    insufficientConfidence: ensemble.insufficientConfidence,
    message: ensemble.message,
    suggestions: ensemble.suggestions,
    explanationStyle,
    interpretationUnlocked: unlocked,
    simpleExplanation: unlocked ? explanations?.simpleExplanation ?? null : null,
    expertExplanation: unlocked ? explanations?.expertExplanation ?? null : null,
    imageObservations: explanations?.imageObservations ?? null,
    warnings: explanations?.warnings ?? null,
    recommendations: explanations?.recommendations ?? null,
  };

  await serviceClient
    .from("scans")
    .update({
      status: "completed",
      final_result: finalResult,
      confidence_band: ensemble.candidates[0]?.confidenceBand ?? null,
      explanation_style: explanationStyle,
      processing_completed_at: processingCompletedAt.toISOString(),
      total_duration_ms: totalDurationMs,
    })
    .eq("id", scanId);

  log("info", "orchestrate-scan", "scan completed", {
    scanId,
    stage: "complete",
    bestMatch: finalResult.bestMatch,
    confidenceScore: finalResult.confidenceScore,
    confidenceBand: finalResult.confidenceBand,
    insufficientConfidence: finalResult.insufficientConfidence,
    providersRun: results.length,
    providersIdentified: results.filter((r) => r.candidate !== null).length,
    totalDurationMs,
  });

  return jsonResponse({
    scanId,
    status: "completed",
    finalResult,
    candidates: ensemble.candidates,
    // Backend-owned Auto Scan Lock threshold, so the app can lock/stop-sending
    // against the server's value rather than a hard-coded one.
    autoLockThreshold: autoLockThreshold(),
  });
}

// Lightweight per-provider circuit breaker: a single slow/down vendor times
// out into an "abstain with error" result rather than hanging the whole scan.
async function withTimeout(
  provider: { name: string; identify: (input: ProviderInput) => Promise<ProviderResult> },
  input: ProviderInput,
): Promise<ProviderResult> {
  const start = Date.now();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ProviderResult>((resolve) => {
    timeoutId = setTimeout(
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
    );
  });

  try {
    const result = await Promise.race([provider.identify(input), timeout]);
    // Whichever settles first, cancel the other timer — otherwise a provider
    // that resolves quickly still leaves its timeout pending for the full
    // PROVIDER_TIMEOUT_MS, which Deno's test sanitizer (correctly) flags as a
    // resource leak.
    clearTimeout(timeoutId);
    return result;
  } catch (err) {
    clearTimeout(timeoutId);
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
