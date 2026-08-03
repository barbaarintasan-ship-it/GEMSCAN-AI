// GIE stage 5 — ASSEMBLE (Sprint 4.3 S4).
//
// Turn the Evidence Set + the AI's reasoning into the final, persist-ready
// assessment: resolve every evidence link, DROP any conclusion with no valid
// supporting evidence (the traceability invariant, enforced in code to match the
// DB trigger), compute each conclusion's confidence + the overall (scoring.ts),
// build weighted edges, and flag any recommendation that over-reaches (>10 m
// without ≥2 independent dataset groups).
import type { Bilingual, EvidenceNode, EvidenceSet, EvidenceType } from "./types.ts";
import type { ConclusionKind, InterpretationLayer, ReasoningOutput } from "./reasoning.ts";
import { edgeWeight, overallConfidence, scoreConclusion } from "./scoring.ts";

export interface AssembledEdge {
  evidenceId: string;
  polarity: "supporting" | "contradicting";
  contribution: number;
  effectiveWeight: number;
}
export interface AssembledConclusion {
  kind: ConclusionKind;
  statement: string;
  statementSo: string;
  isInterpretation: boolean;
  confidence: number; // 0..100
  edges: AssembledEdge[];
}
export interface AssembledRecommendation {
  action: string;
  actionSo: string;
  scaleM?: number;
  evidenceIds: string[];
  flagged: boolean; // over-reach: distance not justified by ≥2 independent datasets
}
export interface Assessment {
  overallConfidence: number; // 0..100
  conclusions: AssembledConclusion[];
  evidence: EvidenceNode[];
  report: {
    headline: Bilingual;         // plain-language one-liner (Simple mode)
    simpleSummary: Bilingual;    // 3–5 everyday sentences (Simple mode)
    opportunity: "high" | "moderate" | "low" | "none";
    interpretation: InterpretationLayer; // Geological Interpretation Layer (teaching narrative)
    uncertainties: Bilingual[];
    missingInformation: Bilingual[];
    recommendations: AssembledRecommendation[];
  };
  droppedConclusions: number; // conclusions removed for lacking valid evidence
}

const CONSERVATIVE_M = 10;

export function assembleAssessment(set: EvidenceSet, reasoning: ReasoningOutput): Assessment {
  const byId = new Map<string, EvidenceNode>(set.nodes.map((n) => [n.id, n]));

  const kept: Array<{ c: AssembledConclusion; score: ReturnType<typeof scoreConclusion> }> = [];
  let dropped = 0;

  for (const rc of reasoning.conclusions) {
    // Keep only links that resolve to a real evidence node.
    const validSupport = rc.supporting.filter((l) => byId.has(l.evidenceId));
    if (validSupport.length === 0) { dropped++; continue; } // INVARIANT: no orphan conclusions

    const score = scoreConclusion(rc, byId);
    const edges: AssembledEdge[] = [
      ...score.supportingWeights.map((x) => ({
        evidenceId: x.link.evidenceId, polarity: "supporting" as const,
        contribution: x.link.contribution, effectiveWeight: x.weight,
      })),
      ...score.contradictingWeights.map((x) => ({
        evidenceId: x.link.evidenceId, polarity: "contradicting" as const,
        contribution: x.link.contribution, effectiveWeight: x.weight,
      })),
    ];
    kept.push({
      c: { kind: rc.kind, statement: rc.statement, statementSo: rc.statementSo, isInterpretation: rc.isInterpretation, confidence: score.confidence, edges },
      score,
    });
  }

  const overall = overallConfidence(kept);

  // Recommendations: flag distance over-reach unless backed by ≥2 independent
  // dataset groups (Principle #6). Only evidence ids that resolve count.
  const recommendations: AssembledRecommendation[] = reasoning.recommendations.map((r) => {
    const ids = r.evidenceIds.filter((id) => byId.has(id));
    const groups = new Set<EvidenceType>();
    for (const id of ids) groups.add(byId.get(id)!.evType);
    const overReach = (r.scaleM ?? 0) > CONSERVATIVE_M && groups.size < 2;
    return { action: r.action, actionSo: r.actionSo, scaleM: r.scaleM, evidenceIds: ids, flagged: overReach };
  });

  return {
    overallConfidence: overall,
    conclusions: kept.map((k) => k.c),
    evidence: set.nodes,
    report: {
      headline: reasoning.headline,
      simpleSummary: reasoning.simpleSummary,
      opportunity: reasoning.opportunity,
      interpretation: reasoning.interpretation,
      uncertainties: reasoning.uncertainties,
      missingInformation: reasoning.missingInformation,
      recommendations,
    },
    droppedConclusions: dropped,
  };
}

// Guard used by scoring re-export (keeps edgeWeight importable from one place).
export { edgeWeight };
