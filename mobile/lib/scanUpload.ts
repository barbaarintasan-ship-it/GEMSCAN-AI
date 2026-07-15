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
import { supabase } from "./supabase";
import type { BoundingBox, CoarseClassification } from "./onDeviceDetection";
import type { QualityAssessment } from "../components/ImageProcessorGL";

const FUNCTIONS_URL = process.env.EXPO_PUBLIC_SUPABASE_FUNCTIONS_URL!;

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
      status: "capturing",
    })
    .select("id")
    .single();

  if (error || !data) throw new Error(error?.message ?? "Failed to create scan");
  return data.id as string;
}

async function uploadFile(path: string, uri: string): Promise<void> {
  const base64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
  const { error } = await supabase.storage
    .from("scan-images")
    .upload(path, decode(base64), { contentType: "image/jpeg", upsert: true });
  if (error) throw new Error(`Upload failed for ${path}: ${error.message}`);
}

export async function uploadScanImage(scanId: string, image: CapturedAngleImage): Promise<void> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Must be signed in to upload a scan image");

  const originalPath = `${user.id}/${scanId}/${image.angle}-original.jpg`;
  const processedPath = `${user.id}/${scanId}/${image.angle}-processed.jpg`;

  await Promise.all([
    uploadFile(originalPath, image.originalUri),
    uploadFile(processedPath, image.processedUri),
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
  };
  candidates: EnsembleCandidateDTO[];
  // Backend-owned Auto Scan Lock threshold (0-1). Optional for backward
  // compatibility with any deployed function that predates the feature; the
  // app falls back to its own default (0.95) when it's absent.
  autoLockThreshold?: number;
};

export async function runOrchestration(
  scanId: string,
  onDeviceHint: CoarseClassification | null,
): Promise<OrchestrateScanResponse> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) throw new Error("Must be signed in to run a scan");

  const res = await fetch(`${FUNCTIONS_URL}/orchestrate-scan`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ scanId, onDeviceHint }),
  });

  const body = await res.json();
  if (!res.ok) {
    throw new Error(body?.error ?? `orchestrate-scan failed with status ${res.status}`);
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
