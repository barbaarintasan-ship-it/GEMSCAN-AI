// GIE stage 4 — SCORE (Sprint 4.3 S4).
//
// Confidence is COMPUTED from the evidence graph, never taken from the AI
// (Principle #4). Per conclusion: tier-weighted noisy-OR over its supporting
// evidence (reusing GeoContext's tier weights), penalised by contradicting
// evidence, then modified by cross-dataset-group agreement. Sparse/weak evidence
// ⇒ low score, automatically.
import { TIER_WEIGHT } from "../confidence.ts";
import type { EvidenceNode, EvidenceType } from "./types.ts";
import type { EvidenceLink, RawConclusion } from "./contracts.ts";

// GIE tiers extend the GeoContext set. ai_visual is deliberately weak; a field
// observation is strong-as-observation; regional map context is mid.
const GIE_TIER_WEIGHT: Record<string, number> = {
  ...TIER_WEIGHT,
  ai_visual: 0.4,
  field_observation: 0.9,
  regional: 0.75,
  // EMIE knowledge base — deliberately weak. Combined with the single-dataset-group
  // cap in scoreConclusion(), knowledge can enrich reasoning but never, alone, drive
  // high confidence (Principle: knowledge enriches, it does not inflate).
  knowledge_kb: 0.35,
};

export function tierWeight(tier?: string): number {
  return tier ? (GIE_TIER_WEIGHT[tier] ?? 1) : 1;
}

// Effective weight of one edge = AI relevance × tier reliability × item quality.
export function edgeWeight(link: EvidenceLink, node: EvidenceNode | undefined): number {
  if (!node) return 0;
  return clamp01(link.contribution * tierWeight(node.tier) * node.quality);
}

function noisyOr(weights: number[]): number {
  let complement = 1;
  for (const w of weights) complement *= (1 - w);
  return weights.length === 0 ? 0 : 1 - complement;
}

export interface ConclusionScore {
  confidence: number; // 0..100
  supportingWeights: Array<{ link: EvidenceLink; weight: number }>;
  contradictingWeights: Array<{ link: EvidenceLink; weight: number }>;
}

// Score a single conclusion from its resolved evidence.
export function scoreConclusion(c: RawConclusion, byId: Map<string, EvidenceNode>): ConclusionScore {
  const supportingWeights = c.supporting
    .map((link) => ({ link, weight: edgeWeight(link, byId.get(link.evidenceId)) }))
    .filter((x) => byId.has(x.link.evidenceId));
  const contradictingWeights = c.contradicting
    .map((link) => ({ link, weight: edgeWeight(link, byId.get(link.evidenceId)) }))
    .filter((x) => byId.has(x.link.evidenceId));

  const support = noisyOr(supportingWeights.map((x) => x.weight));
  const contradict = noisyOr(contradictingWeights.map((x) => x.weight));
  let base = support * (1 - 0.5 * contradict);

  // Cross-dataset-group agreement: independent groups corroborate; single-group
  // evidence is capped (one source shouldn't read as near-certain).
  const groups = new Set<EvidenceType>();
  for (const x of supportingWeights) {
    const n = byId.get(x.link.evidenceId);
    if (n) groups.add(n.evType);
  }
  if (groups.size <= 1) base = Math.min(base, 0.6);
  else if (groups.size >= 3) base = base + (1 - base) * 0.1; // modest corroboration bonus

  return { confidence: Math.round(clamp01(base) * 1000) / 10, supportingWeights, contradictingWeights };
}

// Overall = evidence-weighted mean of conclusion confidences (conclusions with
// more/stronger support count more). 0..100.
export function overallConfidence(scored: Array<{ score: ConclusionScore }>): number {
  if (scored.length === 0) return 0;
  let wsum = 0, acc = 0;
  for (const s of scored) {
    const w = s.score.supportingWeights.reduce((a, x) => a + x.weight, 0) || 0.001;
    acc += s.score.confidence * w;
    wsum += w;
  }
  return Math.round((acc / wsum) * 10) / 10;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));
}
