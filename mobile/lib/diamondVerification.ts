// Advanced Diamond Verification (High-Value Expert Workflow) — the mobile
// contract for this feature, kept separate from scanUpload.ts exactly like
// explanationStyle.ts is kept separate from i18n.ts. Talks to the
// `diamond_verifications` / `diamond_verification_verdicts` tables (migration
// 0009_diamond_verification.sql, RLS: client can insert/update its own
// verification row but never write a verdict) and `high_value_report_purchases`
// (migration 0010, RLS: client can only ever insert its own 'pending' row).
// The verify-high-value Edge Function itself is no longer called directly
// from here — it now only runs server-side, triggered by the payment webhook
// once a purchase is marked 'paid' (see supabase/functions/
// high-value-report-webhook). Never touches scans/scan_images/orchestrate-scan.
import AsyncStorage from "@react-native-async-storage/async-storage";
import { decode } from "base64-arraybuffer";
import * as FileSystem from "expo-file-system";
import { supabase } from "./supabase";

const DRAFT_KEY_PREFIX = "gemscan.verification.";

export type VerificationAnswers = {
  scratchesGlass?: "yes" | "no" | "not_tested";
  scratchesSteel?: "yes" | "no" | "not_tested";
  scratchedByAnotherObject?: "yes" | "no" | "not_tested";
  transparency?: "transparent" | "slightly_cloudy" | "opaque";
  fire?: "very_strong" | "moderate" | "weak" | "none";
  sparkle?: "brilliant" | "moderate" | "dull";
  shape?: "rough_crystal" | "cut_gemstone" | "cabochon" | "unknown";
  color?: string;
  weightValue?: number;
  weightUnit?: "grams" | "carats";
  magnetAttracts?: "yes" | "no" | "not_tested";
  fogClearTime?: "immediately" | "1_2_seconds" | "longer" | "not_tested";
  uvReaction?: "blue" | "green" | "yellow" | "none" | "unknown";
  loupeInclusions?: "natural_inclusions" | "perfectly_clean" | "bubbles" | "unknown";
};

export type VerificationImageLabel = "macro" | "side" | "top" | "bottom" | "edge" | "flash" | "wet";
export type VerificationImagePaths = Partial<Record<VerificationImageLabel, string>>;

export type VerificationRecommendation =
  | "likely_natural_diamond"
  | "likely_lab_diamond"
  | "likely_moissanite"
  | "likely_white_sapphire"
  | "likely_quartz"
  | "cannot_determine"
  | "needs_professional_testing";

export type VerificationVerdict = {
  finalIdentification: string;
  confidence: number;
  probability: string;
  reasoning: string;
  supportingEvidence: string[];
  conflictingEvidence: string[];
  mostLikelyAlternatives: { label: string; note: string }[];
  recommendation: VerificationRecommendation;
  estimatedMarketValue: string;
  professionalTestingRecommended: boolean;
  professionalTestingNote: string;
  // How strong/thorough the collected evidence is (0-100) — NOT the same as
  // `confidence`. See app/(app)/scan/verify.tsx's EVIDENCE_SCORE_BANDS for
  // the qualitative ranges shown to the user.
  evidenceScore: number;
  recommendedNextTests: string[];
};

export type VerificationSession = {
  id: string;
  status: "in_progress" | "submitted" | "completed";
  answers: VerificationAnswers;
  imagePaths: VerificationImagePaths;
};

// Idempotent: returns the existing session for this scan if one was already
// started (so a user who backgrounds the app mid-wizard resumes instead of
// losing progress — `diamond_verifications.scan_id` is unique), else creates
// a fresh one.
export async function startVerification(scanId: string): Promise<VerificationSession> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Must be signed in to start verification");

  const { data: existing } = await supabase
    .from("diamond_verifications")
    .select("id, status, answers, image_paths")
    .eq("scan_id", scanId)
    .maybeSingle();

  if (existing) {
    return {
      id: existing.id as string,
      status: existing.status as VerificationSession["status"],
      answers: (existing.answers as VerificationAnswers) ?? {},
      imagePaths: (existing.image_paths as VerificationImagePaths) ?? {},
    };
  }

  const { data, error } = await supabase
    .from("diamond_verifications")
    .insert({ scan_id: scanId, user_id: user.id, status: "in_progress", answers: {}, image_paths: {} })
    .select("id")
    .single();
  if (error || !data) throw new Error(error?.message ?? "Failed to start verification");

  return { id: data.id as string, status: "in_progress", answers: {}, imagePaths: {} };
}

// Best-effort save-progress — called on every step transition. Never throws:
// a failed save shouldn't block the user from continuing the wizard locally
// (the AsyncStorage draft below is the primary "don't lose my answers" net).
export async function saveVerificationProgress(
  verificationId: string,
  answers: VerificationAnswers,
  imagePaths: VerificationImagePaths,
): Promise<void> {
  try {
    await supabase.from("diamond_verifications").update({ answers, image_paths: imagePaths }).eq("id", verificationId);
  } catch {
    // ignored — the local draft (below) is the source of truth on-device.
  }
}

export async function uploadVerificationImage(
  scanId: string,
  label: VerificationImageLabel,
  uri: string,
): Promise<string> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Must be signed in to upload a verification photo");

  // Reuses the EXISTING scan-images bucket (no new bucket/policies needed) —
  // this path prefix is already covered by that bucket's per-user storage
  // RLS policies (migration 0002_scan_pipeline.sql).
  const path = `${user.id}/${scanId}/verification/${label}.jpg`;
  const base64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
  const { error } = await supabase.storage
    .from("scan-images")
    .upload(path, decode(base64), { contentType: "image/jpeg", upsert: true });
  if (error) throw new Error(`Verification photo upload failed: ${error.message}`);
  return path;
}

// Marks the questionnaire submitted. This used to also call verify-high-value
// immediately; that AI call is now DEFERRED behind the $5 report paywall (see
// startHighValueReportPurchase below) — it only runs once a payment webhook
// marks the purchase 'paid' (supabase/functions/high-value-report-webhook).
export async function markVerificationSubmitted(verificationId: string): Promise<void> {
  await supabase.from("diamond_verifications").update({ status: "submitted" }).eq("id", verificationId);
}

export type HighValueReportPurchase = {
  id: string;
  status: "pending" | "paid";
};

// Idempotent, mirroring startVerification's existing-row-first pattern:
// returns the existing purchase for this verification if the user already
// reached the paywall once, else creates a fresh 'pending' row. Never
// inserts as 'paid' — RLS enforces that (migration 0010).
export async function startHighValueReportPurchase(
  verificationId: string,
  scanId: string,
): Promise<HighValueReportPurchase> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Must be signed in to start a report purchase");

  const { data: existing } = await supabase
    .from("high_value_report_purchases")
    .select("id, status")
    .eq("verification_id", verificationId)
    .maybeSingle();
  if (existing) return existing as HighValueReportPurchase;

  const { data, error } = await supabase
    .from("high_value_report_purchases")
    .insert({ verification_id: verificationId, scan_id: scanId, user_id: user.id, status: "pending" })
    .select("id, status")
    .single();
  if (error || !data) throw new Error(error?.message ?? "Failed to start report purchase");
  return data as HighValueReportPurchase;
}

// Re-read of the purchase status (RLS select-own) — used by the paywall's
// "I've paid — check status" button after the user returns from the website.
export async function getHighValueReportPurchase(
  verificationId: string,
): Promise<HighValueReportPurchase | null> {
  const { data } = await supabase
    .from("high_value_report_purchases")
    .select("id, status")
    .eq("verification_id", verificationId)
    .maybeSingle();
  return (data as HighValueReportPurchase | undefined) ?? null;
}

// Reads a previously-completed verdict directly (RLS select-own — no Edge
// Function round-trip needed for a read), e.g. when resuming a session whose
// AI call already finished.
export async function getVerificationVerdict(verificationId: string): Promise<VerificationVerdict | null> {
  const { data } = await supabase
    .from("diamond_verification_verdicts")
    .select("verdict")
    .eq("verification_id", verificationId)
    .maybeSingle();
  return (data?.verdict as VerificationVerdict | undefined) ?? null;
}

// Local-first draft (mirrors lib/i18n.ts / lib/explanationStyle.ts's
// AsyncStorage pattern) — survives the app being backgrounded/killed
// mid-wizard without a network round-trip for every keystroke/selection.
export type VerificationDraft = { stepIndex: number; answers: VerificationAnswers };

export async function getLocalDraft(scanId: string): Promise<VerificationDraft | null> {
  try {
    const raw = await AsyncStorage.getItem(DRAFT_KEY_PREFIX + scanId);
    return raw ? (JSON.parse(raw) as VerificationDraft) : null;
  } catch {
    return null;
  }
}

export async function setLocalDraft(scanId: string, draft: VerificationDraft): Promise<void> {
  try {
    await AsyncStorage.setItem(DRAFT_KEY_PREFIX + scanId, JSON.stringify(draft));
  } catch {
    // ignored — non-fatal, the wizard still works for the current session.
  }
}

export async function clearLocalDraft(scanId: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(DRAFT_KEY_PREFIX + scanId);
  } catch {
    // ignored
  }
}
