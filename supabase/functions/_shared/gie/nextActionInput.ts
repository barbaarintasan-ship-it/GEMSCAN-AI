// Derives a NextActionInput (nextActionEngine.ts) from the client's combined
// evidence item list (`payload.integratedEvidenceItems` — the SAME list
// finalIntegratedProspectivity() folds AI-visual evidence into).
//
// Reads structure, not free text: every field is decided from the group-name
// convention `structuredEvidenceSource.ts` already owns
// (`evidence:{site}:{canonicalType}`, `:assay:`, `:lithology_reported`,
// `:structural_mapping`, `:confirmed_absent:`) — nothing here asks a model
// anything.
import type { NextActionInput } from "../../../../shared/geo-core/gie/nextActionEngine.ts";
import type { ScoredEvidence } from "../../../../shared/geo-core/gie/prospectivityReport.ts";

/** A strong, verified grade — see assayGrade.ts's GRADE_BAND_FACTOR: high=1.25x, exceptional=1.5x of 0.6. */
const STRONG_ASSAY_WEIGHT_THRESHOLD = 0.6 * 1.25 - 1e-9;
const STRONG_ASSAY_TIERS = new Set(["lab_verified", "expert_verified"]);

export function deriveNextActionInput(items: readonly ScoredEvidence[]): NextActionInput {
  const positiveEvidenceItems = items.filter(
    (i) => i.polarity !== "negative" && i.group.startsWith("evidence:"),
  );
  const negativeGroups = new Set(items.filter((i) => i.polarity === "negative").map((i) => i.group));

  const diagnosticGroups = new Set(
    positiveEvidenceItems
      .filter((i) => !/:assay:|:lithology_reported$|:structural_mapping$/.test(i.group))
      .map((i) => i.group),
  );

  const assayItems = items.filter((i) => i.polarity !== "negative" && i.group.includes(":assay:"));
  const hasAssay = assayItems.length > 0;
  const assayGradeStrong = assayItems.some(
    (i) => i.weight >= STRONG_ASSAY_WEIGHT_THRESHOLD && i.tier != null && STRONG_ASSAY_TIERS.has(i.tier),
  );

  const hasGeophysicsAnomaly = items.some((i) => i.role === "geophysics" && i.polarity !== "negative");
  const hasDetailedMapping = positiveEvidenceItems.some(
    (i) => i.group.endsWith(":lithology_reported") || i.group.endsWith(":structural_mapping"),
  );
  // A structural signal from the ENGINE's own baseline (a mapped fault or
  // contact — group NOT prefixed "evidence:", since that prefix belongs only
  // to the structured form) with nothing subsurface yet to corroborate it.
  const hasBaselineStructural = items.some(
    (i) => i.role === "structural" && !i.group.startsWith("evidence:"),
  );
  const structuralAmbiguity = hasBaselineStructural && !hasGeophysicsAnomaly && !hasDetailedMapping;

  return {
    diagnosticFieldEvidenceCount: diagnosticGroups.size,
    hasAssay,
    assayGradeStrong,
    hasGeophysicsAnomaly,
    hasDetailedMapping,
    structuralAmbiguity,
    confirmedNegativeCount: negativeGroups.size,
  };
}
