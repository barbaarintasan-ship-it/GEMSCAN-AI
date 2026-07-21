// Gold Verification Mode — the mobile contract for this feature, mirroring
// lib/diamondVerification.ts function-for-function against a PARALLEL set of
// tables (gold_verifications / gold_verification_verdicts /
// gold_report_purchases, migration 0013_gold_verification.sql) rather than
// reusing the diamond ones — high_value_report_purchases already has a hard
// FK to diamond_verifications, so a gold purchase needs its own table.
// The verify-gold-value Edge Function is never called directly for the FIRST
// evaluation — that only runs server-side, triggered by the payment webhook
// once a purchase is marked 'paid' (see supabase/functions/
// gold-report-webhook). It IS called directly (with the user's own session)
// for free re-evaluations after editing answers post-payment — the function
// itself requires a 'paid' purchase row to exist before it will run at all.
// Never touches scans/scan_images/orchestrate-scan or any diamond table.
import AsyncStorage from "@react-native-async-storage/async-storage";
import { decode } from "base64-arraybuffer";
import * as FileSystem from "expo-file-system";
import { supabase } from "./supabase";

const FUNCTIONS_URL = process.env.EXPO_PUBLIC_SUPABASE_FUNCTIONS_URL!;
const DRAFT_KEY_PREFIX = "gemscan.goldverification.";

export type GoldVerificationAnswers = {
  origin?: "found_naturally" | "purchased" | "inherited" | "unknown";
  foundLocation?: "river_sediment" | "soil" | "quartz_vein" | "extracted_from_rock";
  magnetAttracts?: "yes" | "no" | "not_tested";
  weightValue?: number;
  weightUnit?: "grams" | "ounces";
  dimensionsLengthMm?: number;
  dimensionsWidthMm?: number;
  dimensionsHeightMm?: number;
  scratchesEasily?: "yes" | "no" | "not_tested";
  streakColor?: "yellow_gold" | "greenish_yellow" | "black" | "gray" | "not_tested";
  colorConsistentUnderLight?: "yes" | "no" | "not_sure";
  malleableOrBrittle?: "flattens_or_dents" | "breaks_or_shatters" | "not_tested";
  acidTestResult?: "not_done" | "no_reaction_passed" | "reacted_failed";
  xrfTestDone?: "yes" | "no" | "not_available";
  claimedKarat?: string;
};

export type GoldVerificationImageLabel = "macro" | "side" | "top" | "bottom" | "edge" | "flash" | "wet" | "xrfReport";
export type GoldVerificationImagePaths = Partial<Record<GoldVerificationImageLabel, string>>;

export type GoldVerificationRecommendation =
  | "likely_natural_gold"
  | "likely_gold_bearing_rock"
  | "likely_jewelry_gold"
  | "likely_gold_plated"
  | "likely_pyrite_or_fools_gold"
  | "likely_brass_or_base_metal"
  | "cannot_determine"
  | "needs_professional_testing";

export type GoldVerificationVerdict = {
  finalIdentification: string;
  confidence: number;
  probability: string;
  reasoning: string;
  supportingEvidence: string[];
  conflictingEvidence: string[];
  mostLikelyAlternatives: { label: string; note: string }[];
  recommendation: GoldVerificationRecommendation;
  // e.g. ["18K", "22K"] — plausible karat range(s), [] if not applicable/undeterminable.
  estimatedPurityOptions: string[];
  estimatedMarketValue: string;
  professionalTestingRecommended: boolean;
  professionalTestingNote: string;
  evidenceScore: number;
  recommendedNextTests: string[];
};

export type GoldVerificationSession = {
  id: string;
  status: "in_progress" | "submitted" | "completed";
  answers: GoldVerificationAnswers;
  imagePaths: GoldVerificationImagePaths;
};

// Idempotent, mirroring startVerification's existing-row-first pattern.
export async function startGoldVerification(scanId: string): Promise<GoldVerificationSession> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Must be signed in to start verification");

  const { data: existing } = await supabase
    .from("gold_verifications")
    .select("id, status, answers, image_paths")
    .eq("scan_id", scanId)
    .maybeSingle();

  if (existing) {
    return {
      id: existing.id as string,
      status: existing.status as GoldVerificationSession["status"],
      answers: (existing.answers as GoldVerificationAnswers) ?? {},
      imagePaths: (existing.image_paths as GoldVerificationImagePaths) ?? {},
    };
  }

  const { data, error } = await supabase
    .from("gold_verifications")
    .insert({ scan_id: scanId, user_id: user.id, status: "in_progress", answers: {}, image_paths: {} })
    .select("id")
    .single();
  if (error || !data) throw new Error(error?.message ?? "Failed to start verification");

  return { id: data.id as string, status: "in_progress", answers: {}, imagePaths: {} };
}

// Best-effort save-progress — never throws, mirrors saveVerificationProgress.
export async function saveGoldVerificationProgress(
  verificationId: string,
  answers: GoldVerificationAnswers,
  imagePaths: GoldVerificationImagePaths,
): Promise<void> {
  try {
    await supabase.from("gold_verifications").update({ answers, image_paths: imagePaths }).eq("id", verificationId);
  } catch {
    // ignored — the local draft (below) is the source of truth on-device.
  }
}

export async function uploadGoldVerificationImage(
  scanId: string,
  label: GoldVerificationImageLabel,
  uri: string,
): Promise<string> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Must be signed in to upload a verification photo");

  // Reuses the EXISTING scan-images bucket, same path convention as diamond
  // verification photos — already covered by that bucket's per-user RLS.
  const path = `${user.id}/${scanId}/verification/${label}.jpg`;
  const base64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
  const { error } = await supabase.storage
    .from("scan-images")
    .upload(path, decode(base64), { contentType: "image/jpeg", upsert: true });
  if (error) throw new Error(`Verification photo upload failed: ${error.message}`);
  return path;
}

export async function markGoldVerificationSubmitted(verificationId: string): Promise<void> {
  await supabase.from("gold_verifications").update({ status: "submitted" }).eq("id", verificationId);
}

export type GoldReportPurchase = {
  id: string;
  status: "pending" | "paid";
};

// Idempotent — mirrors startHighValueReportPurchase. Never inserts as 'paid':
// RLS enforces that (migration 0013).
export async function startGoldReportPurchase(
  verificationId: string,
  scanId: string,
): Promise<GoldReportPurchase> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Must be signed in to start a report purchase");

  const { data: existing } = await supabase
    .from("gold_report_purchases")
    .select("id, status")
    .eq("verification_id", verificationId)
    .maybeSingle();
  if (existing) return existing as GoldReportPurchase;

  const { data, error } = await supabase
    .from("gold_report_purchases")
    .insert({ verification_id: verificationId, scan_id: scanId, user_id: user.id, status: "pending" })
    .select("id, status")
    .single();
  if (error || !data) throw new Error(error?.message ?? "Failed to start report purchase");
  return data as GoldReportPurchase;
}

export async function getGoldReportPurchase(verificationId: string): Promise<GoldReportPurchase | null> {
  const { data } = await supabase
    .from("gold_report_purchases")
    .select("id, status")
    .eq("verification_id", verificationId)
    .maybeSingle();
  return (data as GoldReportPurchase | undefined) ?? null;
}

export type GoldVerificationVerdictRecord = { verdict: GoldVerificationVerdict; createdAt: string };

// Reads the MOST RECENT verdict directly (RLS select-own) — a free
// re-evaluation inserts a NEW row rather than replacing the old one, so this
// verification can have more than one verdict over time; always show the
// latest. Returns createdAt too, for the real evaluation date in the PDF.
export async function getGoldVerificationVerdict(
  verificationId: string,
): Promise<GoldVerificationVerdictRecord | null> {
  const { data } = await supabase
    .from("gold_verification_verdicts")
    .select("verdict, created_at")
    .eq("verification_id", verificationId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) return null;
  return { verdict: data.verdict as GoldVerificationVerdict, createdAt: data.created_at as string };
}

// Free re-evaluation after the user edits their answers post-payment. Calls
// verify-gold-value directly with the user's own session — that function
// requires a 'paid' gold_report_purchases row for this verification before it
// will run, so this can only ever be used once the $5 has actually been paid.
export async function requestGoldReEvaluation(verificationId: string): Promise<GoldVerificationVerdict> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) throw new Error("Must be signed in to re-evaluate");

  const res = await fetch(`${FUNCTIONS_URL}/verify-gold-value`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ verificationId }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.verdict) {
    throw new Error(body?.error ?? `verify-gold-value failed with status ${res.status}`);
  }
  return body.verdict as GoldVerificationVerdict;
}

// Rough bounding-box density estimate (grams / cm³), for comparison against
// gold's ~19.3 g/cm³. Deliberately approximate — accurate for regular
// jewelry shapes, rough for irregular nuggets — the UI and PDF both disclose
// this rather than presenting it as a lab-grade measurement.
export function estimateDensityGramsPerCm3(
  weightGrams: number,
  lengthMm: number,
  widthMm: number,
  heightMm: number,
): number | null {
  if (![weightGrams, lengthMm, widthMm, heightMm].every((n) => Number.isFinite(n) && n > 0)) return null;
  const volumeCm3 = (lengthMm * widthMm * heightMm) / 1000;
  if (volumeCm3 <= 0) return null;
  return weightGrams / volumeCm3;
}

// Local-first draft, mirrors diamondVerification.ts's AsyncStorage pattern.
export type GoldVerificationDraft = { stepIndex: number; answers: GoldVerificationAnswers };

export async function getLocalGoldDraft(scanId: string): Promise<GoldVerificationDraft | null> {
  try {
    const raw = await AsyncStorage.getItem(DRAFT_KEY_PREFIX + scanId);
    return raw ? (JSON.parse(raw) as GoldVerificationDraft) : null;
  } catch {
    return null;
  }
}

export async function setLocalGoldDraft(scanId: string, draft: GoldVerificationDraft): Promise<void> {
  try {
    await AsyncStorage.setItem(DRAFT_KEY_PREFIX + scanId, JSON.stringify(draft));
  } catch {
    // ignored — non-fatal, the wizard still works for the current session.
  }
}

export async function clearLocalGoldDraft(scanId: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(DRAFT_KEY_PREFIX + scanId);
  } catch {
    // ignored
  }
}
