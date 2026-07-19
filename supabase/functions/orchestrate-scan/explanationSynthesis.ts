// Dual Explanation Modes (Simple & Expert) — synthesis step.
//
// The ensemble (ensemble.ts) already decided the winning label from
// weighted multi-model voting; this module does NOT re-derive or influence
// that decision. It only picks WHICH provider's already-generated
// simpleExplanation/expertExplanation prose (see providers/promptShared.ts)
// best represents the winning candidate, so the "consensus preserves style"
// requirement is satisfied without touching voting weights/thresholds at all.
import { normalizeLabel } from "./ensemble.ts";
import type { FullAnalysis, ProviderResult } from "./providers/types.ts";

export type Explanations = {
  simpleExplanation: string;
  expertExplanation: FullAnalysis["expertExplanation"];
  imageObservations: string;
  warnings: string;
  recommendations: string;
};

export function buildExplanations(
  winningLabel: string | null,
  results: ProviderResult[],
  weightByProvider: Map<string, number>,
): Explanations | null {
  const withAnalysis = results.filter(
    (r) => !r.error && r.candidate && r.analysis,
  );
  if (withAnalysis.length === 0) return null;

  const winningKey = winningLabel ? normalizeLabel(winningLabel) : "";
  const matching = winningKey
    ? withAnalysis.filter((r) => normalizeLabel(r.candidate!.label) === winningKey)
    : [];

  const pool = matching.length > 0 ? matching : withAnalysis;
  const best = pool.reduce((a, b) =>
    (weightByProvider.get(b.provider) ?? 0) > (weightByProvider.get(a.provider) ?? 0) ? b : a,
  );

  const analysis = best.analysis!;
  return {
    simpleExplanation: analysis.simpleExplanation,
    expertExplanation: analysis.expertExplanation,
    imageObservations: analysis.imageObservations,
    warnings: analysis.warnings,
    recommendations: analysis.recommendations,
  };
}
