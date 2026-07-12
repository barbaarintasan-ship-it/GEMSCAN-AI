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
  // service_role-scoped client, for providers that need to query reference
  // data (e.g. hallmark OCR matching against `reference_hallmarks`). Never
  // exposed to, or created by, the mobile app.
  serviceClient: SupabaseClient;
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
