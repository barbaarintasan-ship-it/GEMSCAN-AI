// Artifact Verification Mode — the mobile contract for this feature, mirroring
// lib/goldVerification.ts function-for-function against a PARALLEL set of
// tables (artifact_verifications / artifact_verification_verdicts /
// artifact_report_purchases, migration 0015_artifact_verification.sql).
// The verify-artifact-value Edge Function is never called directly for the
// FIRST evaluation — that only runs server-side, triggered by the payment
// webhook once a purchase is marked 'paid' (see supabase/functions/
// artifact-report-webhook). It IS called directly (with the user's own
// session) for free re-evaluations after editing answers post-payment.
// Never touches scans/scan_images/orchestrate-scan or any other verification
// feature's tables.
import AsyncStorage from "@react-native-async-storage/async-storage";
import { decode } from "base64-arraybuffer";
import * as FileSystem from "expo-file-system";
import { supabase } from "./supabase";

const FUNCTIONS_URL = process.env.EXPO_PUBLIC_SUPABASE_FUNCTIONS_URL!;
const DRAFT_KEY_PREFIX = "gemscan.artifactverification.";

export type ArtifactVerificationAnswers = {
  foundLocation?: string;
  buriedInGround?: "fully_buried" | "partially_buried" | "surface" | "purchased_or_inherited" | "not_sure";
  foundWithOtherObjects?: "yes" | "no" | "not_sure";
  otherObjectsNote?: string;
  cleaned?: "heavily_cleaned" | "lightly_cleaned" | "not_cleaned" | "not_sure";
  material?: "pottery_ceramic" | "metal" | "stone" | "bone_ivory" | "glass" | "wood" | "mixed_other" | "unknown";
  condition?: "intact" | "fragment" | "worn_eroded";
  hasInscriptions?: "yes" | "no" | "not_sure";
  weightValue?: number;
  weightUnit?: "grams" | "kilograms";
  approxSizeCm?: number;
  ageClaim?: string;
};

export type ArtifactVerificationImageLabel =
  | "macro"
  | "front"
  | "back"
  | "base"
  | "inside"
  | "broken"
  | "inscription"
  | "scale";
export type ArtifactVerificationImagePaths = Partial<Record<ArtifactVerificationImageLabel, string>>;

export type ArtifactVerificationRecommendation =
  | "likely_genuine_antiquity"
  | "likely_historical_but_common"
  | "likely_modern_reproduction"
  | "likely_replica_or_souvenir"
  | "likely_natural_object_not_artifact"
  | "cannot_determine"
  | "needs_professional_examination";

export type ArtifactVerificationVerdict = {
  finalIdentification: string;
  confidence: number;
  probability: string;
  reasoning: string;
  supportingEvidence: string[];
  conflictingEvidence: string[];
  mostLikelyAlternatives: { label: string; note: string }[];
  recommendation: ArtifactVerificationRecommendation;
  // Hedged text estimates — e.g. "Possibly 1st–3rd century CE" / "Modern".
  estimatedEra: string;
  // Hedged cultural attribution — e.g. "Possibly Aksumite / Red Sea trade".
  estimatedCulture: string;
  // OCR/interpretation of any inscriptions or maker marks; "" if none.
  inscriptionReading: string;
  // Qualitative only, NEVER a specific price (same constraint as gold/diamond).
  estimatedMarketValue: string;
  professionalExaminationRecommended: boolean;
  professionalExaminationNote: string;
  // Cultural-heritage/legal caution — always populated, rendered prominently
  // in the report. Many countries (incl. Somalia) legally protect antiquities;
  // removing, selling, or exporting them can be illegal.
  heritageLegalNote: string;
  evidenceScore: number;
  recommendedNextSteps: string[];
};

export type ArtifactVerificationSession = {
  id: string;
  status: "in_progress" | "submitted" | "completed";
  answers: ArtifactVerificationAnswers;
  imagePaths: ArtifactVerificationImagePaths;
};

// Idempotent, mirroring startGoldVerification's existing-row-first pattern.
export async function startArtifactVerification(scanId: string): Promise<ArtifactVerificationSession> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Must be signed in to start verification");

  const { data: existing } = await supabase
    .from("artifact_verifications")
    .select("id, status, answers, image_paths")
    .eq("scan_id", scanId)
    .maybeSingle();

  if (existing) {
    return {
      id: existing.id as string,
      status: existing.status as ArtifactVerificationSession["status"],
      answers: (existing.answers as ArtifactVerificationAnswers) ?? {},
      imagePaths: (existing.image_paths as ArtifactVerificationImagePaths) ?? {},
    };
  }

  const { data, error } = await supabase
    .from("artifact_verifications")
    .insert({ scan_id: scanId, user_id: user.id, status: "in_progress", answers: {}, image_paths: {} })
    .select("id")
    .single();
  if (error || !data) throw new Error(error?.message ?? "Failed to start verification");

  return { id: data.id as string, status: "in_progress", answers: {}, imagePaths: {} };
}

// Best-effort save-progress — never throws.
export async function saveArtifactVerificationProgress(
  verificationId: string,
  answers: ArtifactVerificationAnswers,
  imagePaths: ArtifactVerificationImagePaths,
): Promise<void> {
  try {
    await supabase
      .from("artifact_verifications")
      .update({ answers, image_paths: imagePaths })
      .eq("id", verificationId);
  } catch {
    // ignored — the local draft (below) is the source of truth on-device.
  }
}

export async function uploadArtifactVerificationImage(
  scanId: string,
  label: ArtifactVerificationImageLabel,
  uri: string,
): Promise<string> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Must be signed in to upload a verification photo");

  // Reuses the EXISTING scan-images bucket, same path convention as the other
  // verification photos — already covered by that bucket's per-user RLS.
  const path = `${user.id}/${scanId}/verification/${label}.jpg`;
  const base64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
  const { error } = await supabase.storage
    .from("scan-images")
    .upload(path, decode(base64), { contentType: "image/jpeg", upsert: true });
  if (error) throw new Error(`Verification photo upload failed: ${error.message}`);
  return path;
}

export async function markArtifactVerificationSubmitted(verificationId: string): Promise<void> {
  await supabase.from("artifact_verifications").update({ status: "submitted" }).eq("id", verificationId);
}

export type ArtifactReportPurchase = {
  id: string;
  status: "pending" | "paid";
};

// Idempotent — mirrors startGoldReportPurchase. Never inserts as 'paid':
// RLS enforces that (migration 0015).
export async function startArtifactReportPurchase(
  verificationId: string,
  scanId: string,
): Promise<ArtifactReportPurchase> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Must be signed in to start a report purchase");

  const { data: existing } = await supabase
    .from("artifact_report_purchases")
    .select("id, status")
    .eq("verification_id", verificationId)
    .maybeSingle();
  if (existing) return existing as ArtifactReportPurchase;

  const { data, error } = await supabase
    .from("artifact_report_purchases")
    .insert({ verification_id: verificationId, scan_id: scanId, user_id: user.id, status: "pending" })
    .select("id, status")
    .single();
  if (error || !data) throw new Error(error?.message ?? "Failed to start report purchase");
  return data as ArtifactReportPurchase;
}

export async function getArtifactReportPurchase(verificationId: string): Promise<ArtifactReportPurchase | null> {
  const { data } = await supabase
    .from("artifact_report_purchases")
    .select("id, status")
    .eq("verification_id", verificationId)
    .maybeSingle();
  return (data as ArtifactReportPurchase | undefined) ?? null;
}

export type ArtifactVerificationVerdictRecord = { verdict: ArtifactVerificationVerdict; createdAt: string };

// Reads the MOST RECENT verdict directly (RLS select-own) — a free
// re-evaluation inserts a NEW row rather than replacing the old one, so
// always show the latest. Returns createdAt too, for the real evaluation date
// in the PDF.
export async function getArtifactVerificationVerdict(
  verificationId: string,
): Promise<ArtifactVerificationVerdictRecord | null> {
  const { data } = await supabase
    .from("artifact_verification_verdicts")
    .select("verdict, created_at")
    .eq("verification_id", verificationId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) return null;
  return { verdict: data.verdict as ArtifactVerificationVerdict, createdAt: data.created_at as string };
}

// Free re-evaluation after the user edits their answers post-payment. Calls
// verify-artifact-value directly with the user's own session — that function
// requires a 'paid' artifact_report_purchases row before it will run.
export async function requestArtifactReEvaluation(verificationId: string): Promise<ArtifactVerificationVerdict> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) throw new Error("Must be signed in to re-evaluate");

  const res = await fetch(`${FUNCTIONS_URL}/verify-artifact-value`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ verificationId }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.verdict) {
    throw new Error(body?.error ?? `verify-artifact-value failed with status ${res.status}`);
  }
  return body.verdict as ArtifactVerificationVerdict;
}

// Local-first draft, mirrors the other verification libs' AsyncStorage pattern.
export type ArtifactVerificationDraft = { stepIndex: number; answers: ArtifactVerificationAnswers };

export async function getLocalArtifactDraft(scanId: string): Promise<ArtifactVerificationDraft | null> {
  try {
    const raw = await AsyncStorage.getItem(DRAFT_KEY_PREFIX + scanId);
    return raw ? (JSON.parse(raw) as ArtifactVerificationDraft) : null;
  } catch {
    return null;
  }
}

export async function setLocalArtifactDraft(scanId: string, draft: ArtifactVerificationDraft): Promise<void> {
  try {
    await AsyncStorage.setItem(DRAFT_KEY_PREFIX + scanId, JSON.stringify(draft));
  } catch {
    // ignored — non-fatal, the wizard still works for the current session.
  }
}

export async function clearLocalArtifactDraft(scanId: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(DRAFT_KEY_PREFIX + scanId);
  } catch {
    // ignored
  }
}
