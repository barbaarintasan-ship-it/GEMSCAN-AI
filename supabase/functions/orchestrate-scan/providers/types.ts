// Shared types for the AI Scan Pipeline provider adapters (Stage 4).
//
// Every cloud/on-device/context provider implements the same `VisionProvider`
// interface. This is the seam that makes the pipeline modular: adding a new
// AI vendor means writing one new file that implements this interface and
// registering it in `providerRegistry.ts` — nothing in index.ts or ensemble.ts
// needs to change.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

export type SignedImage = {
  angle: string;
  url: string; // short-lived signed URL into the `scan-images` storage bucket
};

export type ProviderInput = {
  scanId: string;
  images: SignedImage[];
  specimenCategory: string | null;
  // Stage 2 on-device (YOLO detect + TFLite coarse classify) result, computed
  // client-side and passed through so cloud providers can be given it as
  // context rather than re-deriving it.
  onDeviceHint: { label: string; confidence: number } | null;
  // Optional coarse, user-supplied location (already fuzzed client-side per
  // the location-fuzzing policy in 05-Monetization-Legal-Payments.md).
  location: { lat: number; lng: number; label?: string } | null;
  // The user's chosen Dual Explanation Mode for this scan (see
  // 03-AI-Architecture-and-Data-Sources.md). Providers are asked to write
  // BOTH a Simple and an Expert explanation regardless, so History/PDF can
  // switch later, but give this one the most depth/care.
  explanationStyle: "simple" | "expert";
  // The app's current display language. Controls what language the
  // narrative/explanation text (reasoning, simpleExplanation,
  // expertExplanation prose fields, imageObservations, warnings,
  // recommendations) is written in — NOT the identification `label` itself,
  // which always stays in its canonical scientific/English form (see
  // promptShared.ts) so the rest of the app (keyword matching, valuation
  // lookups, hallmark matching) keeps working unchanged.
  lang: "en" | "so";
  // service_role-scoped client, for providers that need to query reference
  // data (e.g. hallmark OCR matching against `reference_hallmarks`). Never
  // exposed to, or created by, the mobile app.
  serviceClient: SupabaseClient;
};

// The full gemological/mineralogical write-up behind Dual Explanation Modes.
// All string fields (LLM prose) — deliberately flat and untyped-numeric so
// parsing stays defensive (see promptShared.ts) the same way `confidence`
// already is the only field that needs numeric coercion.
export type ExpertAnalysis = {
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

export type FullAnalysis = {
  simpleExplanation: string;
  expertExplanation: ExpertAnalysis;
  imageObservations: string;
  warnings: string;
  recommendations: string;
};

export type ProviderCandidate = {
  label: string;
  confidence: number; // 0-1, this provider's own confidence
};

export type ProviderResult = {
  provider: string;
  candidate: ProviderCandidate | null; // null if the provider abstains
  alternatives: ProviderCandidate[];
  reasoning: string;
  latencyMs: number;
  error?: string;
  raw?: unknown; // full raw response, persisted to scan_ai_responses for audit
  // Dual Explanation Modes structured write-up, when this provider produced
  // one (only the general vision providers do). Null/absent for on-device,
  // hallmark OCR, and geological context, and for any abstained result.
  analysis?: FullAnalysis | null;
};

export interface VisionProvider {
  name: string;
  // Base weight in the weighted-confidence ensemble (Stage 5). Relative, not
  // required to sum to 1 — ensemble.ts normalizes by the weights of the
  // providers that actually returned a result for a given scan.
  baseWeight: number;
  // Whether this provider should run at all for a given input (e.g. hallmark
  // OCR only runs for jewelry/coin categories; geological context only runs
  // if a location was supplied).
  isApplicable(input: ProviderInput): boolean;
  // If true, this provider only runs for callers whose subscription features
  // include `ensembleScans` (premium/lifetime/professional). Free-tier scans
  // still get a real identification (on-device + a single cloud model +
  // hallmark/geological context where applicable) — this is what the app's
  // "Deep Scan (multi-model AI ensemble)" premium gate actually unlocks
  // server-side, not just in the UI.
  requiresEnsembleTier?: boolean;
  identify(input: ProviderInput): Promise<ProviderResult>;
}
