// Stage 5/6: the DECISION ENGINE — deterministic identification + confidence.
//
// RELIABILITY FIX. Previously each model was asked for its own `confidence` and
// this file computed `weight_i * confidence_i`. An LLM's self-reported number is
// not a calibrated probability, so the same specimen could come back "Diamond
// 88%" once and "Celestite 50%" later purely from model mood. That number is
// now gone: providers report WHAT they see (a label + ranked alternatives) and
// this engine decides, from evidence that is the same every run:
//
//   support   — noisy-OR over the INDEPENDENT providers that named the label,
//               weighted by each provider's registered reliability (baseWeight)
//   agreement — one lone provider is capped (a single opinion is never proof)
//   separation— a photo-finish between two candidates is not an identification
//   quality   — poor images cannot yield a confident answer
//
// Same evidence in ⇒ same number out, always. Nothing here calls an AI.
import type { ProviderResult } from "./providers/types.ts";

// An alternative a provider lists still counts as evidence for that label,
// discounted relative to its actual top pick.
const ALTERNATIVE_WEIGHT_DISCOUNT = 0.5;

// Strength of ONE provider's top pick as evidence. Deliberately < 1 so that a
// single model, however sure it sounds, can never on its own produce certainty.
const SINGLE_EVIDENCE_STRENGTH = 0.62;

// The reference weight of a first-class vision model (see providerRegistry).
// Provider reliability is expressed relative to this.
const REFERENCE_PROVIDER_WEIGHT = 0.28;

// A label supported by only ONE provider is capped here — mirrors the
// single-dataset-group cap already used by the enterprise engine (gie/scoring).
const SINGLE_SOURCE_CAP = 0.6;

// Geological context re-ranks (rather than just votes) — matching labels get a
// modest boost, clamped so it can never overturn vision-model disagreement.
const GEOLOGICAL_BOOST_MULTIPLIER = 1.15;

const HIGH_CONFIDENCE_THRESHOLD = 0.72;
const MEDIUM_CONFIDENCE_THRESHOLD = 0.45;
// Below this, Stage 6 refuses to claim an identification at all.
const INSUFFICIENT_CONFIDENCE_THRESHOLD = 0.35;

// Two candidates this close are competing, not ranked — the honest answer is
// "inconclusive", not a coin flip presented as a result.
const MIN_SEPARATION = 0.1;

export const INSUFFICIENT_CONFIDENCE_MESSAGE =
  "We cannot identify this specimen with sufficient confidence from the available images.";

export const COMPETING_CANDIDATES_MESSAGE =
  "Two or more minerals match this specimen equally well. A physical test is needed to tell them apart.";

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
  message: string | null;
  suggestions: string[]; // only populated when insufficientConfidence is true
  // Whether confidence cleared the acceptance threshold that unlocks geological
  // interpretation / exploration advice (index.ts gates the write-up on this).
  interpretationUnlocked: boolean;
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

// Independent evidence combines: 1 - Π(1 - w). Agreement raises confidence,
// a single source cannot reach certainty.
function noisyOr(weights: number[]): number {
  if (weights.length === 0) return 0;
  let complement = 1;
  for (const w of weights) complement *= 1 - w;
  return 1 - complement;
}

/**
 * Decide the identification.
 *
 * @param results        one entry per provider that ran (abstentions included)
 * @param weightByProvider registered baseWeight per provider name
 * @param imageQuality   mean Stage-1 image quality 0..1 (1 = unknown/neutral).
 *                       Poor images cannot produce a confident identification.
 */
export function runEnsemble(
  results: ProviderResult[],
  weightByProvider: Map<string, number>,
  imageQuality = 1,
): EnsembleResult {
  // Evidence per label: the effective weight contributed by each DISTINCT
  // provider (a provider that names a label twice still counts once).
  const evidenceByLabel = new Map<string, Map<string, number>>();
  const displayLabel = new Map<string, string>();

  for (const result of results) {
    if (result.error || !result.candidate) continue;
    const weight = weightByProvider.get(result.provider) ?? 0;
    if (weight <= 0) continue;

    // Provider reliability relative to a first-class vision model, then scaled
    // so one provider alone is strong evidence but never proof.
    const reliability = Math.min(1, weight / REFERENCE_PROVIDER_WEIGHT);

    const addEvidence = (label: string, discount: number) => {
      const key = normalizeLabel(label);
      if (!key) return;
      const w = clamp01(reliability * SINGLE_EVIDENCE_STRENGTH * discount);
      if (w <= 0) return;
      const perProvider = evidenceByLabel.get(key) ?? new Map<string, number>();
      // Keep the STRONGEST claim this provider made for the label (its top
      // pick outranks the same label appearing in its own alternatives).
      perProvider.set(result.provider, Math.max(perProvider.get(result.provider) ?? 0, w));
      evidenceByLabel.set(key, perProvider);
      if (!displayLabel.has(key)) displayLabel.set(key, label.trim());
    };

    addEvidence(result.candidate.label, 1);
    for (const alt of result.alternatives) {
      addEvidence(alt.label, ALTERNATIVE_WEIGHT_DISCOUNT);
    }
  }

  if (evidenceByLabel.size === 0) {
    return inconclusive(INSUFFICIENT_CONFIDENCE_MESSAGE);
  }

  const q = clamp01(imageQuality);

  // Score each label from its evidence alone.
  let scored = [...evidenceByLabel.entries()].map(([key, perProvider]) => {
    const weights = [...perProvider.values()];
    let score = noisyOr(weights);
    // A single opinion is never proof, regardless of which provider it is.
    if (perProvider.size <= 1) score = Math.min(score, SINGLE_SOURCE_CAP);
    // Poor images cannot produce a confident identification.
    score *= q;
    return {
      key,
      label: displayLabel.get(key)!,
      score,
      providers: [...perProvider.keys()],
    };
  });

  // Geological context re-ranks a label vision already proposed — it never
  // introduces one, and the clamp keeps it from overturning disagreement.
  const geoResult = results.find((r) => r.provider === "geological_context" && r.candidate);
  if (geoResult?.candidate) {
    const boosted = new Set(
      [geoResult.candidate.label, ...geoResult.alternatives.map((a) => a.label)].map(normalizeLabel),
    );
    scored = scored.map((s) =>
      boosted.has(s.key) ? { ...s, score: clamp01(s.score * GEOLOGICAL_BOOST_MULTIPLIER) } : s,
    );
  }

  scored.sort((a, b) => b.score - a.score);
  const ranked = scored.slice(0, 6); // best match + top 5 alternatives
  const best = ranked[0];
  const runnerUp = ranked[1];

  // Separation: a photo finish is not an identification.
  const margin = runnerUp && best.score > 0 ? (best.score - runnerUp.score) / best.score : 1;
  const competing = !!runnerUp && margin < MIN_SEPARATION;
  // Scale confidence down as the field tightens (full credit from a 30% margin).
  const separationFactor = 0.7 + 0.3 * Math.min(1, Math.max(0, margin) / 0.3);

  const finalScore = clamp01(best.score * separationFactor);
  const insufficient = competing || finalScore < INSUFFICIENT_CONFIDENCE_THRESHOLD;

  const candidates: EnsembleCandidate[] = ranked.map((entry, index) => {
    const rank = index + 1;
    const score = clamp01(entry.score * (rank === 1 ? separationFactor : 1));
    // Customer-facing wording — the identification method is a trade secret, so
    // no provider names or internal technique are exposed here.
    const rationale =
      rank === 1
        ? insufficient
          ? `Considered, but the available evidence does not confirm it.`
          : `Identified as the best match with ${(score * 100).toFixed(0)}% confidence from our expert gemstone analysis.`
        : `Considered as a possible alternative.`;
    const rejectedReason =
      rank === 1
        ? null
        : `Ranked below the top match — ${(score * 100).toFixed(0)}% confidence vs ${(finalScore * 100).toFixed(0)}% for "${best.label}".`;

    return {
      rank,
      label: entry.label,
      weightedConfidence: score,
      confidenceBand: confidenceBand(score),
      rationale,
      rejectedReason,
    };
  });

  return {
    candidates,
    insufficientConfidence: insufficient,
    message: competing
      ? COMPETING_CANDIDATES_MESSAGE
      : insufficient
      ? INSUFFICIENT_CONFIDENCE_MESSAGE
      : null,
    suggestions: insufficient ? defaultSuggestions() : [],
    // Geological interpretation / exploration advice stays locked until the
    // identification itself clears the acceptance threshold.
    interpretationUnlocked: !insufficient && finalScore >= HIGH_CONFIDENCE_THRESHOLD,
  };
}

function inconclusive(message: string): EnsembleResult {
  return {
    candidates: [],
    insufficientConfidence: true,
    message,
    suggestions: defaultSuggestions(),
    interpretationUnlocked: false,
  };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function defaultSuggestions(): string[] {
  return [
    "Add a macro close-up photo taken in bright, even lighting.",
    "Capture any additional angles you skipped (top, bottom, and both sides help the most).",
    "If you know roughly where the specimen was found, add that location to enable locality-based matching.",
    "For jewelry or coins, make sure any stamped marks or engravings are in sharp focus.",
  ];
}
