// Shared types for the Advanced Diamond Verification (High-Value Expert
// Workflow) — a second, optional, evidence-driven stage offered after a scan
// that looks like it might be a diamond-family/high-value gemstone. Kept
// entirely separate from orchestrate-scan/providers/types.ts on purpose: this
// feature must never risk touching the primary identification pipeline.

// The structured questionnaire collected by the mobile wizard. Every field is
// optional — a user can skip any step (photos especially) and still submit;
// the AI is told explicitly when something wasn't tested/provided.
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

// Storage paths (within the existing scan-images bucket) of any extra photos
// captured during the wizard — every key optional.
export type VerificationImagePaths = {
  macro?: string;
  side?: string;
  top?: string;
  bottom?: string;
  edge?: string;
  flash?: string;
  wet?: string;
};

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
  confidence: number; // 0-1
  probability: string; // short plain-language likelihood statement, distinct from the numeric confidence
  reasoning: string; // "why this conclusion was reached"
  // Section A / Section B of the final report. conflictingEvidence may be
  // empty — the UI shows an explicit "no conflicting evidence" message in
  // that case rather than hiding the section.
  supportingEvidence: string[];
  conflictingEvidence: string[];
  mostLikelyAlternatives: { label: string; note: string }[];
  recommendation: VerificationRecommendation;
  // Deliberately a short text descriptor, not a numeric USD figure — the
  // existing numeric market-value estimate (lib/valuation.ts / estimate-value)
  // is a separate, untouched system; this stays qualitative to avoid any
  // overlap or conflicting numbers between the two.
  estimatedMarketValue: string;
  professionalTestingRecommended: boolean;
  professionalTestingNote: string;
  // How strong/thorough the COLLECTED EVIDENCE is (0-100) — explicitly NOT
  // the same thing as `confidence` (which is the AI's belief in the specific
  // identification). Two identifications can both be evidence-rich even if
  // one is confidently wrong; this score reflects the quality/consistency of
  // what was gathered, not the verdict itself. See prompt.ts for the
  // qualitative bands (Exceptional/Strong/Moderate/Limited/Insufficient).
  evidenceScore: number;
  // Section C of the final report — only the specific tests genuinely
  // relevant to this identification/confidence level, drawn from a fixed
  // list (see prompt.ts), not every possible test every time.
  recommendedNextTests: string[];
};
