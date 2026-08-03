// Shared types for Gold Verification Mode — a second, optional,
// evidence-driven stage offered after a scan that looks like it might be
// gold (native gold, gold-bearing rock, gold ore/concentrate, or suspicious
// jewelry). Kept entirely separate from orchestrate-scan/providers/types.ts
// and from verify-high-value/types.ts on purpose: this feature must never
// risk touching the primary identification pipeline or the diamond
// verification pipeline.

// The structured questionnaire collected by the mobile wizard. Every field is
// optional — a user can skip any step and still submit; the AI is told
// explicitly when something wasn't tested/provided.
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

// Storage paths (within the existing scan-images bucket) of any extra photos
// captured during the wizard — every key optional. xrfReport is a photo of a
// lab/XRF printout, not a specimen angle.
export type GoldVerificationImagePaths = {
  macro?: string;
  side?: string;
  top?: string;
  bottom?: string;
  edge?: string;
  flash?: string;
  wet?: string;
  xrfReport?: string;
};

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
  confidence: number; // 0-1 — identification confidence, distinct from evidenceScore below
  probability: string; // short plain-language likelihood statement
  reasoning: string;
  supportingEvidence: string[];
  conflictingEvidence: string[]; // may be empty — UI shows an explicit "none" message rather than hiding the section
  mostLikelyAlternatives: { label: string; note: string }[];
  recommendation: GoldVerificationRecommendation;
  // e.g. ["18K", "22K"] — plausible karat/fineness range(s) given visual +
  // hallmark + physical evidence, [] if not applicable (e.g. clearly not gold)
  // or genuinely undeterminable.
  estimatedPurityOptions: string[];
  // Deliberately a short qualitative descriptor, never a specific USD figure —
  // mirrors VerificationVerdict.estimatedMarketValue for the same reason
  // (the numeric lib/valuation.ts estimate is a separate, untouched system).
  estimatedMarketValue: string;
  professionalTestingRecommended: boolean;
  professionalTestingNote: string;
  // How strong/thorough the COLLECTED EVIDENCE is (0-100) — explicitly NOT
  // the same thing as `confidence`. See prompt.ts for the qualitative bands.
  evidenceScore: number;
  recommendedNextTests: string[];
};
