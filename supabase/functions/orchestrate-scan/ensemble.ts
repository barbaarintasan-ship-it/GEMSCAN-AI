// Stage 5: weighted-confidence ensemble voting engine.
// Stage 6: final result shaping (best match, top 5 alternatives, confidence
// band, why-chosen/why-rejected, and the mandatory low-confidence fallback).
//
// This is deliberately NOT simple majority voting. Every provider result
// contributes weight_i * confidence_i to the labels it names (its top
// candidate at full weight, its listed alternatives at a discount), so
// providers that (a) carry more base trust and (b) are more confident this
// time both count for more — and providers that abstain or error contribute
// nothing rather than being counted as a "no" vote.
import type { ProviderResult } from "./providers/types.ts";

// An alternative a provider lists still counts as evidence for that label
// (useful when providers disagree on #1 but two of them both had it in their
// top few), just discounted relative to a provider's actual top pick.
const ALTERNATIVE_WEIGHT_DISCOUNT = 0.5;

// Geological context re-ranks (rather than just votes) — matching labels get
// multiplied by a modest boost, clamped so it can never overturn strong
// vision-model disagreement on its own.
const GEOLOGICAL_BOOST_MULTIPLIER = 1.15;

const HIGH_CONFIDENCE_THRESHOLD = 0.72;
const MEDIUM_CONFIDENCE_THRESHOLD = 0.45;
// Below this, Stage 6 requires the app to refuse to claim an identification
// at all, rather than present a low-confidence guess as if it were one.
const INSUFFICIENT_CONFIDENCE_THRESHOLD = 0.35;

export const INSUFFICIENT_CONFIDENCE_MESSAGE =
  "We cannot identify this specimen with sufficient confidence from the available images.";

export type EnsembleCandidate = {
  rank: number;
  label: string;
  weightedConfidence: number;
  confidenceBand: "low" | "medium" | "high";
  rationale: string;
  rejectedReason: string | null;
};

export type EnsembleResult = {
  candidates: EnsembleCandidate[]; // rank 1 = best match, 2-6 = alternatives
  insufficientConfidence: boolean;
  message: string | null; // set to INSUFFICIENT_CONFIDENCE_MESSAGE when insufficient
  suggestions: string[]; // only populated when insufficientConfidence is true
};

function confidenceBand(score: number): "low" | "medium" | "high" {
  if (score >= HIGH_CONFIDENCE_THRESHOLD) return "high";
  if (score >= MEDIUM_CONFIDENCE_THRESHOLD) return "medium";
  return "low";
}

// Normalizes a raw label so trivially different strings from different
// providers (casing, plural, whitespace) merge into one ensemble bucket
// instead of splitting votes. This is intentionally simple string
// normalization, not semantic matching — providers are prompted to return
// concise canonical names, and Stage 4's on-device hint / reference-data
// matches already tend to be canonical.
export function normalizeLabel(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, " ");
}

export function runEnsemble(
  results: ProviderResult[],
  weightByProvider: Map<string, number>,
): EnsembleResult {
  const scoreByLabel = new Map<string, number>(); // normalized -> aggregate score
  const displayLabel = new Map<string, string>(); // normalized -> original casing
  const supportingProviders = new Map<string, string[]>(); // normalized -> provider names
  let totalParticipatingWeight = 0;

  for (const result of results) {
    if (result.error || !result.candidate) continue;
    const weight = weightByProvider.get(result.provider) ?? 0;
    if (weight <= 0) continue;

    totalParticipatingWeight += weight;

    const addVote = (label: string, confidence: number, discount: number) => {
      const key = normalizeLabel(label);
      if (!key) return;
      const score = weight * confidence * discount;
      scoreByLabel.set(key, (scoreByLabel.get(key) ?? 0) + score);
      if (!displayLabel.has(key)) displayLabel.set(key, label.trim());
      const providers = supportingProviders.get(key) ?? [];
      if (!providers.includes(result.provider)) providers.push(result.provider);
      supportingProviders.set(key, providers);
    };

    addVote(result.candidate.label, result.candidate.confidence, 1);
    for (const alt of result.alternatives) {
      addVote(alt.label, alt.confidence, ALTERNATIVE_WEIGHT_DISCOUNT);
    }
  }

  // Apply the Geological Context Engine as a re-ranking boost on top of the
  // vote it already cast above, rather than only as one more voter — this is
  // what makes it "locality-aware re-ranking" rather than just another vote.
  const geoResult = results.find((r) => r.provider === "geological_context" && r.candidate);
  if (geoResult?.candidate) {
    const boostLabels = [geoResult.candidate.label, ...geoResult.alternatives.map((a) => a.label)];
    for (const label of boostLabels) {
      const key = normalizeLabel(label);
      if (scoreByLabel.has(key)) {
        scoreByLabel.set(key, scoreByLabel.get(key)! * GEOLOGICAL_BOOST_MULTIPLIER);
      }
    }
  }

  if (scoreByLabel.size === 0 || totalParticipatingWeight === 0) {
    return {
      candidates: [],
      insufficientConfidence: true,
      message: INSUFFICIENT_CONFIDENCE_MESSAGE,
      suggestions: defaultSuggestions(),
    };
  }

  // Normalize by total participating weight so a scan where, say, one vendor
  // API failed doesn't automatically depress every score.
  const ranked = [...scoreByLabel.entries()]
    .map(([key, score]) => ({
      key,
      label: displayLabel.get(key)!,
      normalizedScore: Math.min(1, score / totalParticipatingWeight),
      providers: supportingProviders.get(key) ?? [],
    }))
    .sort((a, b) => b.normalizedScore - a.normalizedScore)
    .slice(0, 6); // best match + top 5 alternatives

  const best = ranked[0];
  const insufficientConfidence = best.normalizedScore < INSUFFICIENT_CONFIDENCE_THRESHOLD;

  const candidates: EnsembleCandidate[] = ranked.map((entry, index) => {
    const rank = index + 1;
    const band = confidenceBand(entry.normalizedScore);
    // Customer-facing wording — the identification method is a trade secret, so
    // no provider names or internal technique are exposed here.
    const rationale =
      rank === 1
        ? `Identified as the best match with ${(entry.normalizedScore * 100).toFixed(0)}% confidence from our expert gemstone analysis.`
        : `Considered as a possible alternative.`;
    const rejectedReason =
      rank === 1
        ? null
        : `Ranked below the top match — ${(entry.normalizedScore * 100).toFixed(0)}% confidence vs ${(best.normalizedScore * 100).toFixed(0)}% for "${best.label}".`;

    return {
      rank,
      label: entry.label,
      weightedConfidence: entry.normalizedScore,
      confidenceBand: band,
      rationale,
      rejectedReason,
    };
  });

  return {
    candidates,
    insufficientConfidence,
    message: insufficientConfidence ? INSUFFICIENT_CONFIDENCE_MESSAGE : null,
    suggestions: insufficientConfidence ? defaultSuggestions() : [],
  };
}

function defaultSuggestions(): string[] {
  return [
    "Add a macro close-up photo taken in bright, even lighting.",
    "Capture any additional angles you skipped (top, bottom, and both sides help the most).",
    "If you know roughly where the specimen was found, add that location to enable locality-based matching.",
    "For jewelry or coins, make sure any stamped marks or engravings are in sharp focus.",
  ];
}
