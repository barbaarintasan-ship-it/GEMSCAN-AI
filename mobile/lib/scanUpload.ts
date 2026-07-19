// Stage 1/2/3 -> Stage 4 handoff: creates the `scans` + `scan_images` rows
// (owned by the signed-in user, per migration 0002_scan_pipeline.sql),
// uploads both the original and on-device-enhanced photos to the private
// `scan-images` Storage bucket, then calls orchestrate-scan (Stage 4-7).
//
// This is the ONLY place in the mobile app that talks to Supabase Storage
// for scan images and to the orchestrate-scan Edge Function — kept in one
// module so the upload/orchestration contract is easy to audit.
import { decode } from "base64-arraybuffer";
import * as FileSystem from "expo-file-system";
import * as ImageManipulator from "expo-image-manipulator";
import { supabase } from "./supabase";
import i18n from "./i18n";
import type { BoundingBox, CoarseClassification } from "./onDeviceDetection";
import type { QualityAssessment } from "../components/ImageProcessorGL";

const FUNCTIONS_URL = process.env.EXPO_PUBLIC_SUPABASE_FUNCTIONS_URL!;

// The "original" photo is kept purely for storage/audit — AI providers only
// ever see the "processed" (enhanced, ImageProcessorGL.ENHANCE_OUTPUT_SIZE =
// 1024px) image (orchestrate-scan/index.ts signs `processed_storage_path ??
// original_storage_path`). So resizing/re-encoding the original here has ZERO
// effect on identification quality — it only cuts upload time/bandwidth for
// a copy that's never sent to any AI model.
const ORIGINAL_MAX_WIDTH = 1600;
const ORIGINAL_COMPRESS = 0.8;

// Resize + re-encode the full-sensor-resolution original down to a much
// smaller upload without visible quality loss, preferring WebP (smaller than
// JPEG at equivalent visual quality) and falling back to JPEG — same
// dimension cap either way — if WebP encoding isn't available on this device.
// Never throws: on any failure this returns the original URI unmodified, so
// an optimization here can never block a scan from completing.
async function prepareOriginalForUpload(
  uri: string,
): Promise<{ uri: string; ext: "webp" | "jpg"; contentType: "image/webp" | "image/jpeg" }> {
  try {
    const webp = await ImageManipulator.manipulateAsync(
      uri,
      [{ resize: { width: ORIGINAL_MAX_WIDTH } }],
      { compress: ORIGINAL_COMPRESS, format: ImageManipulator.SaveFormat.WEBP },
    );
    return { uri: webp.uri, ext: "webp", contentType: "image/webp" };
  } catch {
    try {
      const jpeg = await ImageManipulator.manipulateAsync(
        uri,
        [{ resize: { width: ORIGINAL_MAX_WIDTH } }],
        { compress: ORIGINAL_COMPRESS, format: ImageManipulator.SaveFormat.JPEG },
      );
      return { uri: jpeg.uri, ext: "jpg", contentType: "image/jpeg" };
    } catch {
      return { uri, ext: "jpg", contentType: "image/jpeg" };
    }
  }
}

// Runs `items` through `fn` with at most `limit` in flight at once — full
// parallelism speeds up a multi-angle upload significantly, but running all
// (up to 8 images x 2 files) at once would hold that many base64 buffers in
// memory simultaneously on a mobile device. Bounded concurrency gets most of
// the speedup with a fixed memory ceiling.
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(new Array(Math.min(limit, items.length)).fill(0).map(() => worker()));
  return results;
}

export type CapturedAngleImage = {
  angle: "front" | "back" | "left" | "right" | "top" | "bottom" | "macro" | "wet";
  originalUri: string;
  processedUri: string;
  quality: QualityAssessment;
  detectionBbox: BoundingBox | null;
};

export type ScanLocation = { lat: number; lng: number; label?: string; acc?: number };

export async function createScan(params: {
  specimenCategory: string | null;
  location: ScanLocation | null;
  explanationStyle?: ExplanationStyle | null;
}): Promise<string> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Must be signed in to start a scan");

  const { data, error } = await supabase
    .from("scans")
    .insert({
      user_id: user.id,
      specimen_category: params.specimenCategory,
      capture_location: params.location,
      explanation_style: params.explanationStyle ?? null,
      status: "capturing",
    })
    .select("id")
    .single();

  if (error || !data) throw new Error(error?.message ?? "Failed to create scan");
  return data.id as string;
}

async function uploadFile(path: string, uri: string, contentType: string): Promise<void> {
  const base64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
  const { error } = await supabase.storage
    .from("scan-images")
    .upload(path, decode(base64), { contentType, upsert: true });
  if (error) throw new Error(`Upload failed for ${path}: ${error.message}`);
}

export async function uploadScanImage(scanId: string, image: CapturedAngleImage): Promise<void> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Must be signed in to upload a scan image");

  // Only the original is resized/re-encoded here — the processed (AI-facing)
  // image's own size/quality (set by ImageProcessorGL.enhance()) is untouched.
  const prepared = await prepareOriginalForUpload(image.originalUri);
  const originalPath = `${user.id}/${scanId}/${image.angle}-original.${prepared.ext}`;
  const processedPath = `${user.id}/${scanId}/${image.angle}-processed.jpg`;

  await Promise.all([
    uploadFile(originalPath, prepared.uri, prepared.contentType),
    uploadFile(processedPath, image.processedUri, "image/jpeg"),
  ]);

  const { error } = await supabase.from("scan_images").insert({
    scan_id: scanId,
    angle: image.angle,
    original_storage_path: originalPath,
    processed_storage_path: processedPath,
    quality_score: image.quality.qualityScore,
    quality_flags: {
      blurry: image.quality.blurry,
      lowLight: image.quality.lowLight,
      overexposed: image.quality.overexposed,
    },
    detection_bbox: image.detectionBbox,
  });

  if (error) throw new Error(`Failed to save scan_images row: ${error.message}`);
}

export type EnsembleCandidateDTO = {
  rank: number;
  label: string;
  weightedConfidence: number;
  confidenceBand: "low" | "medium" | "high";
  rationale: string;
  rejectedReason: string | null;
};

// Dual Explanation Modes: the full gemological write-up for Expert mode.
// Optional for backward compatibility with scans/deployed functions that
// predate this feature — every field may be absent on older data.
export type ExpertExplanationDTO = {
  mineralSpecies: string;
  variety: string;
  crystalSystem: string;
  chemicalComposition: string;
  mohsHardness: string;
  specificGravity: string;
  refractiveIndex: string;
  cleavage: string;
  fracture: string;
  luster: string;
  transparency: string;
  diagnosticCharacteristics: string;
  geologicalOrigin: string;
  commonTreatments: string;
  syntheticIndicators: string;
  commonImitations: string;
  confidenceReasoning: string;
  recommendedLabTests: string;
  marketDemand: string;
  wholesaleEstimate: string;
  retailEstimate: string;
  investmentConsiderations: string;
};

export type OrchestrateScanResponse = {
  scanId: string;
  status: "completed";
  finalResult: {
    bestMatch: string | null;
    confidenceScore: number;
    confidenceBand: "low" | "medium" | "high";
    reasoning: string | null;
    alternatives: EnsembleCandidateDTO[];
    insufficientConfidence: boolean;
    message: string | null;
    suggestions: string[];
    explanationStyle?: ExplanationStyle | null;
    simpleExplanation?: string | null;
    expertExplanation?: ExpertExplanationDTO | null;
    imageObservations?: string | null;
    warnings?: string | null;
    recommendations?: string | null;
  };
  candidates: EnsembleCandidateDTO[];
  // Backend-owned Auto Scan Lock threshold (0-1). Optional for backward
  // compatibility with any deployed function that predates the feature; the
  // app falls back to its own default (0.95) when it's absent.
  autoLockThreshold?: number;
};

export type ScanType = "standard" | "deep";

// The user's chosen Dual Explanation Mode. Sent with every scan request so
// providers can favor it, while both styles are still generated for later
// switching in History/PDF (see lib/explanationStyle.ts for the remembered
// preference).
export type ExplanationStyle = "simple" | "expert";

/**
 * Error thrown by runOrchestration that carries the backend's machine-readable
 * `code` (e.g. "deep_credits_exhausted", "standard_limit_reached") so the UI can
 * react — show the out-of-credits sheet, etc. — instead of a generic message.
 */
export class OrchestrationError extends Error {
  code?: string;
  info?: unknown;
  constructor(message: string, code?: string, info?: unknown) {
    super(message);
    this.name = "OrchestrationError";
    this.code = code;
    this.info = info;
  }
}

export async function runOrchestration(
  scanId: string,
  onDeviceHint: CoarseClassification | null,
  scanType: ScanType = "standard",
  explanationStyle: ExplanationStyle = "simple",
  // Lets the caller cancel the in-flight request (e.g. the user navigated
  // away from the analyzing screen) instead of it running to completion
  // uselessly. Deliberately NOT retried client-side on failure — a retry
  // after a server-side success-but-lost-response could double-consume a
  // Deep Scan credit, so any failure here (including a real network error)
  // is surfaced to the caller as-is rather than silently re-attempted.
  signal?: AbortSignal,
): Promise<OrchestrateScanResponse> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) throw new Error("Must be signed in to run a scan");

  // The app's current display language — read directly from the shared i18n
  // instance (not passed in by the caller) so it's always accurate regardless
  // of which screen calls runOrchestration, and controls what language the AI
  // writes its narrative explanation text in (see orchestrate-scan's
  // promptShared.ts). The identification label itself always stays in its
  // canonical scientific/English form regardless of this setting.
  const lang: "en" | "so" = i18n.language === "so" ? "so" : "en";

  const res = await fetch(`${FUNCTIONS_URL}/orchestrate-scan`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      "Content-Type": "application/json",
    },
    // scanType decides cost server-side: "standard" = one cheap model,
    // "deep" = the metered 3-AI ensemble (spends a Deep Scan credit).
    // explanationStyle is the user's Dual Explanation Mode preference.
    body: JSON.stringify({ scanId, onDeviceHint, scanType, explanationStyle, lang }),
    signal,
  });

  const body = await res.json();
  if (!res.ok) {
    throw new OrchestrationError(
      body?.error ?? `orchestrate-scan failed with status ${res.status}`,
      body?.code,
      body,
    );
  }
  return body as OrchestrateScanResponse;
}

export async function submitScanFeedback(
  scanId: string,
  feedback: { wasCorrect: boolean; correctedLabel?: string; notes?: string },
): Promise<void> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Must be signed in to submit feedback");

  const { error } = await supabase.from("scan_feedback").insert({
    scan_id: scanId,
    user_id: user.id,
    was_correct: feedback.wasCorrect,
    corrected_label: feedback.correctedLabel ?? null,
    notes: feedback.notes ?? null,
  });

  if (error) throw new Error(`Failed to save feedback: ${error.message}`);
}
