// GeoContext runtime — confidence model (Architecture §9).
//
// Confidence is evidence-based, never an assertion of presence. Factors:
//   * source reliability tier (evidence_tier) → per-item base weight,
//   * corroboration — independent evidence combines (noisy-OR), so multiple
//     agreeing signals raise confidence,
//   * community only strengthens (already reflected in its item weights upstream).
// Output: a 0..1 score, a Low/Moderate/High band, and human-readable factors.

import type { ConfidenceBand, ConfidenceBlock, EvidenceItem } from "./types.ts";

// Reliability multiplier by evidence tier (unknown tiers use 1.0 — the item's own
// weight already carries most of the signal).
export const TIER_WEIGHT: Record<string, number> = {
  community: 0.5,
  historical: 0.7,
  mapped: 0.85,
  expert_verified: 0.95,
  lab_verified: 1.0,
};

export function bandFor(score: number): ConfidenceBand {
  if (score < 0.34) return "Low";
  if (score < 0.67) return "Moderate";
  return "High";
}

function effectiveWeight(item: EvidenceItem): number {
  const tierMult = item.tier ? (TIER_WEIGHT[item.tier] ?? 1) : 1;
  return Math.max(0, Math.min(1, item.weight * tierMult));
}

export function computeConfidence(
  evidence: EvidenceItem[],
  opts: {
    byProvider?: Record<string, number>;
    providersRun?: string[];
    providersFailed?: string[];
  } = {},
): ConfidenceBlock {
  // Noisy-OR over independent evidence: score = 1 - Π(1 - w_i).
  let complement = 1;
  for (const item of evidence) complement *= (1 - effectiveWeight(item));
  const score = evidence.length === 0 ? 0 : Math.round((1 - complement) * 100) / 100;

  const factors: string[] = [];
  // Top evidence statements (by effective weight) become the confidence factors.
  const top = [...evidence]
    .sort((a, b) => effectiveWeight(b) - effectiveWeight(a))
    .slice(0, 6)
    .map((e) => e.statement);
  factors.push(...top);
  if ((opts.providersRun?.length ?? 0) > 1) {
    factors.push(`Corroborated across ${opts.providersRun!.length} providers`);
  }
  if ((opts.providersFailed?.length ?? 0) > 0) {
    factors.push(`${opts.providersFailed!.length} provider(s) unavailable — confidence conservative`);
  }
  if (evidence.length === 0) factors.push("No supporting evidence at this location");

  return {
    overall: bandFor(score),
    score,
    byProvider: opts.byProvider ?? {},
    factors,
  };
}
