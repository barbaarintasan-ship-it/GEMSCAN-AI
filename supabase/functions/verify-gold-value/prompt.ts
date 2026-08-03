// Prompt + response parsing for the Gold Verification final AI call.
// Deliberately independent of orchestrate-scan/providers/promptShared.ts and
// of verify-high-value/prompt.ts — this feature must never risk touching the
// primary identification prompt or the diamond verification prompt.
import type { GoldVerificationAnswers, GoldVerificationRecommendation, GoldVerificationVerdict } from "./types.ts";

export type GoldVerificationPromptInput = {
  previousResult: {
    bestMatch: string;
    confidenceScore: number; // 0-1
    confidenceBand: "low" | "medium" | "high";
    reasoning: string | null;
    alternatives: { label: string; confidence: number }[];
  };
  hallmark: { matchedLabel: string | null; marks: string[] } | null;
  answers: GoldVerificationAnswers;
  // Which extra photo angles were actually supplied, in the same order as the
  // image parts attached to the request.
  imageLabels: string[];
  location: { lat: number; lng: number; label?: string } | null;
};

function answerLine(label: string, value: unknown): string {
  if (value === undefined || value === null || value === "") return `- ${label}: not provided`;
  return `- ${label}: ${value}`;
}

// Rough bounding-box density estimate (g/cm³) — computed deterministically
// server-side rather than trusted to the model's arithmetic, same spirit as
// weightLine in verify-high-value/prompt.ts. Duplicated (not imported) from
// lib/goldVerification.ts's estimateDensityGramsPerCm3 — this function has
// zero code dependency on the mobile app, matching the isolation convention
// used throughout this feature.
function estimateDensityGramsPerCm3(
  weightGrams: number,
  lengthMm: number,
  widthMm: number,
  heightMm: number,
): number | null {
  if (![weightGrams, lengthMm, widthMm, heightMm].every((n) => Number.isFinite(n) && n > 0)) return null;
  const volumeCm3 = (lengthMm * widthMm * heightMm) / 1000;
  if (volumeCm3 <= 0) return null;
  return weightGrams / volumeCm3;
}

export function buildVerificationPrompt(input: GoldVerificationPromptInput): string {
  const { previousResult, hallmark, answers, imageLabels, location } = input;

  const altsLine = previousResult.alternatives.length
    ? previousResult.alternatives.map((a) => `${a.label} (${(a.confidence * 100).toFixed(0)}%)`).join(", ")
    : "none";

  const hallmarkLine = hallmark
    ? `Hallmark/stamp data: ${hallmark.matchedLabel ?? "no reference match"}${
        hallmark.marks.length ? ` (transcribed marks: ${hallmark.marks.join(", ")})` : ""
      }.`
    : "No hallmark/stamp data available.";

  const locationLine = location
    ? `Approximate find location: lat ${location.lat}, lng ${location.lng}${
        location.label ? ` (${location.label})` : ""
      }.`
    : "No location was supplied.";

  const imagesLine = imageLabels.length
    ? `You are also given ${imageLabels.length} additional close-up photo(s) taken specifically for this ` +
      `verification, in this order: ${imageLabels.join(", ")}.`
    : "No additional verification photos were supplied — rely on the original scan and the questionnaire only.";

  const weightUnit = answers.weightUnit ?? "grams";
  const weightGrams =
    answers.weightValue != null ? (weightUnit === "ounces" ? answers.weightValue * 28.3495 : answers.weightValue) : null;
  const weightLine =
    answers.weightValue != null ? `- Weight: ${answers.weightValue} ${weightUnit}` : "- Weight: not provided";
  const dimensionsLine =
    answers.dimensionsLengthMm != null && answers.dimensionsWidthMm != null && answers.dimensionsHeightMm != null
      ? `- Approximate dimensions: ${answers.dimensionsLengthMm} x ${answers.dimensionsWidthMm} x ${answers.dimensionsHeightMm} mm`
      : "- Approximate dimensions: not provided";
  const density =
    weightGrams != null && answers.dimensionsLengthMm != null && answers.dimensionsWidthMm != null && answers.dimensionsHeightMm != null
      ? estimateDensityGramsPerCm3(
          weightGrams,
          answers.dimensionsLengthMm,
          answers.dimensionsWidthMm,
          answers.dimensionsHeightMm,
        )
      : null;
  const densityLine =
    density != null
      ? `- Calculated approximate density: ${density.toFixed(2)} g/cm³ (bounding-box estimate from weight and dimensions above — rough for irregular shapes like nuggets, more reliable for regular jewelry shapes; pure gold is ~19.3 g/cm³, 18K gold alloy is typically ~15.2-15.9 g/cm³, 14K is typically ~12.9-13.6 g/cm³, and common look-alikes like pyrite (~5.0) or brass (~8.4-8.7) are much lower)`
      : "- Calculated approximate density: not available (weight and/or dimensions not provided)";

  return `You are a senior precious-metals appraiser performing a SECOND-STAGE evidence-based verification for \
GemScan AI. A consumer app already ran an initial photo-based identification; you are now given that result PLUS \
structured physical test answers the user collected themselves, to reach a more careful, evidence-weighted \
conclusion about whether this item is genuinely gold. This applies to any possible form of gold: a native gold \
nugget, gold-bearing rock or ore, gold concentrate, gold jewelry, or a suspected gold-plated/base-metal item — and \
must also correctly flag common look-alikes such as pyrite ("fool's gold"), mica, chalcopyrite, or brass.

ORIGINAL SCAN RESULT:
- Best match: ${previousResult.bestMatch} (${(previousResult.confidenceScore * 100).toFixed(0)}% confidence, ${previousResult.confidenceBand} band)
- Original reasoning: ${previousResult.reasoning ?? "none recorded"}
- Alternatives considered: ${altsLine}
${hallmarkLine}
${locationLine}

USER-COLLECTED PHYSICAL TEST EVIDENCE (self-reported by the user, not lab-verified — weigh accordingly):
${answerLine("How obtained", answers.origin)}
${answerLine("Found location", answers.foundLocation)}
${answerLine("Magnet attraction", answers.magnetAttracts)}
${weightLine}
${dimensionsLine}
${densityLine}
${answerLine("Scratch test", answers.scratchesEasily)}
${answerLine("Streak test color", answers.streakColor)}
${answerLine("Color consistent under different lighting", answers.colorConsistentUnderLight)}
${answerLine("Malleability (dents vs. cracks under pressure)", answers.malleableOrBrittle)}
${answerLine("Acid test result", answers.acidTestResult)}
${answerLine("XRF / professional assay done", answers.xrfTestDone)}
${answerLine("Claimed/visible karat stamp", answers.claimedKarat)}

${imagesLine}

Weigh ALL of this evidence together (original scan + physical tests + density calculation + hallmark stamps + new \
photos) to reach ONE final conclusion.

NEVER state that the item is definitely genuine gold or a definitely specific purity — you are working from \
user-reported field tests and photographs, not a certified lab instrument. Always hedge appropriately: prefer \
wording like "Likely", "Possibly", "Strongly consistent with", "Evidence suggests", or "Professional assay/XRF \
confirmation recommended" rather than flat assertions. A magnetic response, a black/dark streak, or a positive \
acid-test reaction are all strong evidence AGAINST genuine gold; a non-magnetic response, yellow-gold streak, \
color consistent in all lighting, malleable (dents rather than cracks) behavior, and a density consistent with \
gold or a gold alloy are all evidence FOR it — but none of these alone is proof.

List EVERY piece of evidence that supports your conclusion in "supportingEvidence", each explained clearly \
(e.g. "Non-magnetic response, consistent with genuine gold", "Density of 17.8 g/cm³ falls within the expected \
range for 22K gold", "Streak test produced a yellow-gold color"). List EVERY piece of evidence that reduces \
confidence in "conflictingEvidence" (e.g. "Magnet attracted the specimen — inconsistent with genuine gold", \
"Density is far too low for solid gold, more consistent with a gold-plated base metal"); if there is genuinely \
nothing conflicting, return an empty array — do not invent conflicts.

Classify into "recommendation" using ONLY one of: "likely_natural_gold" (native nugget/gold-bearing rock/gold \
concentrate found naturally), "likely_gold_bearing_rock" (gold visible within a rock/quartz matrix, not yet \
separated), "likely_jewelry_gold" (a manufactured item, evidence consistent with genuine gold), \
"likely_gold_plated" (a manufactured item where evidence suggests a thin gold layer over a different base metal), \
"likely_pyrite_or_fools_gold" (evidence points to pyrite or a similar non-gold mineral), \
"likely_brass_or_base_metal" (evidence points to brass or another base metal, not gold at all), \
"cannot_determine", or "needs_professional_testing" (evidence is too sparse or contradictory to lean either way).

Provide "estimatedPurityOptions" as a short list of plausible karat/fineness values (e.g. ["18K","22K"] or \
["750","916"]) ONLY when the evidence (hallmark stamps, density, visual color) is consistent with jewelry/refined \
gold of determinable purity — return an empty array for native nuggets/ore, non-gold items, or when purity truly \
cannot be narrowed down.

Also provide an "evidenceScore" (0-100): this is NOT the same as "confidence" — confidence is how sure you are \
about the specific identification, while evidenceScore reflects how strong, thorough, and internally consistent \
the COLLECTED EVIDENCE itself is (how many tests were actually performed vs. skipped/"not tested", whether the \
density calculation was possible, whether hallmark and physical evidence agree with each other). Use these bands: \
95-100 exceptional evidence, 85-94 strong evidence, 70-84 moderate evidence, 50-69 limited evidence, below 50 \
insufficient evidence (e.g. almost everything was skipped or answers contradict each other).

Recommend ONLY the specific next tests genuinely relevant to resolving remaining uncertainty, chosen from this \
fixed list — do not include irrelevant ones just to fill the list: "Acid Test Kit", "Electronic Gold Tester", \
"XRF Analyzer", "Specific Gravity / Density Test", "Certified Assay Office", "Fire Assay", "Magnet Test", \
"Streak Test". Return an empty array if the evidence is already strong enough that no further testing is needed.

Respond with ONLY minified JSON, no markdown, matching exactly this shape:
{"finalIdentification": string (e.g. "Natural gold candidate", "Likely gold-plated costume jewelry"), \
"confidence": number between 0 and 1, \
"probability": string (short plain-language likelihood statement, e.g. "Likely (60-75%)"), \
"reasoning": string (why you reached this conclusion), \
"supportingEvidence": string[] (every specific reason that supports the conclusion, clearly explained), \
"conflictingEvidence": string[] (every specific reason that conflicts with it — empty array if none), \
"mostLikelyAlternatives": [{"label": string, "note": string}, ... up to 3 items], \
"recommendation": "likely_natural_gold"|"likely_gold_bearing_rock"|"likely_jewelry_gold"|"likely_gold_plated"|"likely_pyrite_or_fools_gold"|"likely_brass_or_base_metal"|"cannot_determine"|"needs_professional_testing", \
"estimatedPurityOptions": string[] (e.g. ["18K","22K"], empty array if not applicable/undeterminable), \
"estimatedMarketValue": string (brief qualitative description, e.g. "Low — likely gold-plated" or "Potentially significant if confirmed natural — professional assay needed"; NEVER a specific price), \
"professionalTestingRecommended": boolean, \
"professionalTestingNote": string (empty string if not recommended), \
"evidenceScore": number between 0 and 100, \
"recommendedNextTests": string[] (only entries from the fixed list above that are actually relevant, empty array if none needed)}`;
}

const RECOMMENDATIONS: GoldVerificationRecommendation[] = [
  "likely_natural_gold",
  "likely_gold_bearing_rock",
  "likely_jewelry_gold",
  "likely_gold_plated",
  "likely_pyrite_or_fools_gold",
  "likely_brass_or_base_metal",
  "cannot_determine",
  "needs_professional_testing",
];

function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function clamp01(n: unknown): number {
  const v = Number(n);
  if (Number.isNaN(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

// Missing/invalid defaults to 0, which correctly falls into the
// "insufficient evidence" band — a safe default rather than implying
// evidence that was never actually assessed.
function clampScore(n: unknown): number {
  const v = Number(n);
  if (Number.isNaN(v)) return 0;
  return Math.max(0, Math.min(100, Math.round(v)));
}

// Defensive by field, same spirit as verify-high-value/prompt.ts — a model
// omitting or mistyping any single field must never fail parsing of the
// rest of the verdict.
export function parseVerificationResponse(text: string): GoldVerificationVerdict {
  const cleaned = text.trim().replace(/^```(json)?/i, "").replace(/```$/, "").trim();
  const parsed = JSON.parse(cleaned) as Record<string, unknown>;

  const recommendation = RECOMMENDATIONS.includes(parsed.recommendation as GoldVerificationRecommendation)
    ? (parsed.recommendation as GoldVerificationRecommendation)
    : "cannot_determine";

  return {
    finalIdentification: str(parsed.finalIdentification) || "Unknown",
    confidence: clamp01(parsed.confidence),
    probability: str(parsed.probability),
    reasoning: str(parsed.reasoning),
    supportingEvidence: Array.isArray(parsed.supportingEvidence)
      ? parsed.supportingEvidence.map((s) => str(s)).filter(Boolean)
      : [],
    conflictingEvidence: Array.isArray(parsed.conflictingEvidence)
      ? parsed.conflictingEvidence.map((s) => str(s)).filter(Boolean)
      : [],
    mostLikelyAlternatives: Array.isArray(parsed.mostLikelyAlternatives)
      ? parsed.mostLikelyAlternatives
          .slice(0, 3)
          .map((a) => {
            const o = (a && typeof a === "object" ? a : {}) as Record<string, unknown>;
            return { label: str(o.label), note: str(o.note) };
          })
          .filter((a) => a.label)
      : [],
    recommendation,
    estimatedPurityOptions: Array.isArray(parsed.estimatedPurityOptions)
      ? parsed.estimatedPurityOptions.map((s) => str(s)).filter(Boolean)
      : [],
    estimatedMarketValue: str(parsed.estimatedMarketValue),
    professionalTestingRecommended: parsed.professionalTestingRecommended === true,
    professionalTestingNote: str(parsed.professionalTestingNote),
    evidenceScore: clampScore(parsed.evidenceScore),
    recommendedNextTests: Array.isArray(parsed.recommendedNextTests)
      ? parsed.recommendedNextTests.map((s) => str(s)).filter(Boolean)
      : [],
  };
}
