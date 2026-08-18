// Displayed prospectivity — the number a geologist READS on the report.
//
// WHY THIS IS NOT THE RANKING SCORE
//
// The engine's `computeConfidence` (confidence.ts) answers "how strong is the
// evidence here", and the whole targeting stack is validated on it (LOO AUC 0.900,
// BLIND 0.843). It is a pure noisy-OR: two strong field observations at one outcrop
// — a quartz vein and a fault seen in the same photo — combine to ~1.00, which is
// exactly right for RANKING one cell against another, and exactly wrong as a number
// shown to a person, because it reads as near-certainty built from a single visit
// with no assay, no geochemistry, no regional structure, no known occurrence.
//
// So this file adds a DISPLAY layer and nothing else. It never feeds ranking, never
// touches `computeConfidence`, and the raw score is still what orders the targets.
// It only decides what the report prints, by two rules a geologist would recognise:
//
//   1. SINGLE-GROUP CAP — evidence from one category (only field observations, or
//      only one map layer) cannot read as high confidence, however strong it is.
//      Diversity of INDEPENDENT categories is what separates a hunch from a case.
//   2. COMPLETENESS GATE — with no corroborating dataset present at all (no
//      occurrence, no mapped/interpreted structure, no photograph read, no community
//      confirmation), the displayed score is shrunk: the picture is incomplete and
//      the number should say so.
//
// Every threshold is CONFIGURABLE (per the requirement) — nothing is hard-coded —
// so the caps can be tuned or measured without editing the arithmetic.
import { TIER_WEIGHT } from "../confidence.ts";

/** The minimum an evidence item needs to be scored here. Mirrors confidence.ts. */
export interface ScoredEvidence {
  /** Item base weight, before the tier multiplier. */
  weight: number;
  /** Reliability tier (mapped, community, …) — same table as confidence.ts. */
  tier?: string;
  /** Evidence CATEGORY (field, structural, geology, occurrence, terrain, visual, …). */
  role: string;
  /** Correlation key: items sharing it are one observation seen twice. */
  group: string;
}

export interface ReportScoreConfig {
  /** Ceiling when all evidence is one category. */
  singleCategoryCap: number;
  /** Ceiling when evidence spans exactly two categories. */
  twoCategoryCap: number;
  /**
   * Categories that count as INDEPENDENT corroboration. Field observations are the
   * primary signal, not corroboration of themselves; lithology/terrain are weak
   * context. Presence of any of these lifts the completeness gate.
   */
  corroboratingRoles: string[];
  /** Multiplier applied when NO corroborating category is present (0..1). */
  incompletePenalty: number;
}

/**
 * Defaults. Field-only evidence is capped hard and penalised for incompleteness;
 * two categories relax the cap; three or more remove it. Tunable without touching
 * the math.
 */
export const DEFAULT_REPORT_SCORE_CONFIG: ReportScoreConfig = {
  singleCategoryCap: 0.5,
  twoCategoryCap: 0.75,
  corroboratingRoles: ["occurrence", "structural", "contacts", "visual", "community"],
  incompletePenalty: 0.85,
};

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));
}

function effectiveWeight(e: ScoredEvidence): number {
  const tierMult = e.tier ? (TIER_WEIGHT[e.tier] ?? 1) : 1;
  return clamp01(e.weight * tierMult);
}

/**
 * The number to DISPLAY, 0..1. Deterministic and pure.
 *
 * Base is the same tier-weighted noisy-OR the ranking uses, over group-collapsed
 * evidence (correlated items counted once). The caps and completeness gate then
 * pull an over-confident base down to what the breadth of evidence supports.
 */
export function reportProspectivity(
  scored: ScoredEvidence[],
  config: ReportScoreConfig = DEFAULT_REPORT_SCORE_CONFIG,
): number {
  // Collapse correlated evidence: strongest effective weight per group.
  const byGroup = new Map<string, number>();
  for (const e of scored) {
    const w = effectiveWeight(e);
    const cur = byGroup.get(e.group);
    if (cur == null || w > cur) byGroup.set(e.group, w);
  }

  // Noisy-OR over the independent groups — the raw strength.
  let complement = 1;
  for (const w of byGroup.values()) complement *= (1 - w);
  let score = byGroup.size === 0 ? 0 : 1 - complement;

  // Rule 1 — single-group / two-group cap on CATEGORY diversity.
  const categories = new Set(scored.map((e) => e.role));
  if (categories.size <= 1) score = Math.min(score, config.singleCategoryCap);
  else if (categories.size === 2) score = Math.min(score, config.twoCategoryCap);

  // Rule 2 — completeness gate: no corroborating dataset present at all.
  const hasCorroboration = [...categories].some((r) => config.corroboratingRoles.includes(r));
  if (!hasCorroboration) score *= config.incompletePenalty;

  return Math.round(clamp01(score) * 100) / 100;
}
