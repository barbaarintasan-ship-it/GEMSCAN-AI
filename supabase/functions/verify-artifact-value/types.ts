// Shared types for Artifact Verification Mode — a second, optional,
// evidence-driven stage offered after a scan that looks like it might be a
// historical/archaeological artifact. Kept entirely separate from the scan
// pipeline and the diamond/gold verification pipelines on purpose.

// The structured questionnaire collected by the mobile wizard. Every field is
// optional — a user can skip any step and still submit; the AI is told
// explicitly when something wasn't provided.
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

// Storage paths (within the existing scan-images bucket) of any extra photos
// captured during the wizard — every key optional.
export type ArtifactVerificationImagePaths = {
  macro?: string;
  front?: string;
  back?: string;
  base?: string;
  inside?: string;
  broken?: string;
  inscription?: string;
  scale?: string;
};

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
  confidence: number; // 0-1 — identification confidence, distinct from evidenceScore
  probability: string;
  reasoning: string;
  supportingEvidence: string[];
  conflictingEvidence: string[];
  mostLikelyAlternatives: { label: string; note: string }[];
  recommendation: ArtifactVerificationRecommendation;
  // Hedged text — e.g. "Possibly 1st–3rd century CE", "Modern (last ~50 yrs)".
  estimatedEra: string;
  // Hedged cultural attribution — e.g. "Possibly Aksumite / Red Sea trade".
  estimatedCulture: string;
  // OCR/interpretation of any inscriptions or maker's marks; "" if none seen.
  inscriptionReading: string;
  // Qualitative only, NEVER a specific price.
  estimatedMarketValue: string;
  professionalExaminationRecommended: boolean;
  professionalExaminationNote: string;
  // ALWAYS populated (never empty). Cultural-heritage/legal caution — many
  // countries legally protect antiquities and restrict their removal, sale,
  // or export. Rendered prominently in the report regardless of the verdict.
  heritageLegalNote: string;
  evidenceScore: number; // 0-100, independent of confidence
  recommendedNextSteps: string[];
};
