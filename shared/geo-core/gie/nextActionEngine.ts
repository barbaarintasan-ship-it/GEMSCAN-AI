// The deterministic next-action engine (Architecture: Integrated Prospectivity
// Score, Priority 3).
//
// THE PROBLEM THIS FIXES: FindingRecommendation.action used to be whatever
// snake_case string the model felt like writing, with no engine-side rule
// deciding when a mission genuinely warrants an assay vs geophysics vs
// stopping. That is a free-form guess dressed as structured output.
//
// ENGINE DECIDES WHAT. AI EXPLAINS WHY. This file is the whole "WHAT" — a
// small, pure, fully-tested decision table over STRUCTURED evidence counts,
// never the model's own text. `analyzeExplorationPackage()`
// (_shared/gie/analyzeMission.ts) calls this and REPLACES whatever the model
// produced; the model may still write narrative reasoning, but it can no
// longer choose the action code.
import type { FindingRecommendation } from "./missionFindings.ts";

export type NextAction =
  | "continue_field_investigation"
  | "collect_sample"
  | "recommend_lab_assay"
  | "recommend_geophysics"
  | "recommend_detailed_mapping"
  | "recommend_field_observation"
  | "deprioritize_target"
  | "insufficient_evidence";

/**
 * What the engine actually knows, in structured counts — never free text.
 * Every field is derived from real evidence (Scored/ScoredEvidence groups,
 * confirmed-absent findings, assay grade bands), not asked of a model.
 */
export interface NextActionInput {
  /** Distinct POSITIVE field/geochemistry/geophysics indicator groups present. */
  diagnosticFieldEvidenceCount: number;
  hasAssay: boolean;
  /** A "high" or "exceptional" exploration-geochemistry band (assayGrade.ts), or a real lab_verified result. */
  assayGradeStrong: boolean;
  hasGeophysicsAnomaly: boolean;
  /** Detailed mapping (structuredEvidenceTypes.ts Section C) was actually entered, not just baseline geology. */
  hasDetailedMapping: boolean;
  /** Structural evidence exists (a fault/contact/vein) with nothing subsurface to corroborate it. */
  structuralAmbiguity: boolean;
  /** Count of DISTINCT confirmed-absent (Priority 1) indicator groups. */
  confirmedNegativeCount: number;
}

/**
 * Rank what the geologist should do next, best first — up to three actions.
 *
 * Pure and deterministic: same input, same output, every time. The five rules
 * below are exactly the five worked examples from the approved instruction;
 * nothing here was invented beyond them.
 */
export function determineNextActions(input: NextActionInput): FindingRecommendation[] {
  const strongPositive = input.diagnosticFieldEvidenceCount >= 2;
  const anyPositive = input.diagnosticFieldEvidenceCount >= 1;

  // Rule: multiple checked-negative indicators + weak positive evidence ->
  // deprioritize. Exclusive — nothing else is worth recommending once this fires.
  if (input.confirmedNegativeCount >= 2 && !strongPositive) {
    return [{ action: "deprioritize_target", priority: 1, becauseOf: ["confirmed_absent_indicators"] }];
  }

  // Rule: genuinely nothing to go on. Also exclusive. A bare structural signal
  // (a mapped fault with nothing else) is NOT "nothing" — it is exactly the
  // case the structural-ambiguity rule below exists to answer ("consider
  // geophysics"), so it is excluded from this gate rather than swallowed by it.
  if (!anyPositive && input.confirmedNegativeCount === 0 && !input.hasAssay &&
      !input.hasGeophysicsAnomaly && !input.structuralAmbiguity) {
    return [{ action: "insufficient_evidence", priority: 1, becauseOf: [] }];
  }

  const out: FindingRecommendation[] = [];

  // Rule: a strong, already-verified assay in hand -> advance to the next
  // appropriate step, never just "take another sample".
  if (input.hasAssay && input.assayGradeStrong) {
    out.push({
      action: input.hasDetailedMapping ? "recommend_geophysics" : "recommend_detailed_mapping",
      priority: 1, becauseOf: ["assay"],
    });
  } else if (anyPositive && !input.hasAssay) {
    // Rule: diagnostic field evidence exists + no assay. Weak signal -> go get
    // material; corroborated signal -> it is worth a lab already.
    out.push(
      strongPositive
        ? { action: "recommend_lab_assay", priority: 1, becauseOf: ["field_observation"] }
        : { action: "collect_sample", priority: 2, becauseOf: ["field_observation"] },
    );
  }

  // Rule: structural ambiguity + insufficient subsurface information -> geophysics.
  if (input.structuralAmbiguity && !input.hasGeophysicsAnomaly) {
    out.push({ action: "recommend_geophysics", priority: 2, becauseOf: ["structural_ambiguity"] });
  }

  // Rule: strong geological potential but poor geological mapping -> detailed mapping.
  if (strongPositive && !input.hasDetailedMapping) {
    out.push({ action: "recommend_detailed_mapping", priority: 2, becauseOf: ["diagnostic_evidence"] });
  }

  if (out.length === 0) {
    out.push({
      action: anyPositive ? "continue_field_investigation" : "recommend_field_observation",
      priority: 1, becauseOf: [],
    });
  }

  // De-duplicate by action (keep the best/lowest priority number), then rank.
  const byAction = new Map<string, FindingRecommendation>();
  for (const r of out) {
    const cur = byAction.get(r.action);
    if (!cur || r.priority < cur.priority) byAction.set(r.action, r);
  }
  return [...byAction.values()].sort((a, b) => a.priority - b.priority).slice(0, 3);
}
