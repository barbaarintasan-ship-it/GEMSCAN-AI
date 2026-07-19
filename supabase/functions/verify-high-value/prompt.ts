// Prompt + response parsing for the Advanced Diamond Verification final AI
// call. Deliberately independent of orchestrate-scan/providers/promptShared.ts
// — this feature must never risk touching the primary identification prompt.
import type { VerificationAnswers, VerificationRecommendation, VerificationVerdict } from "./types.ts";

export type VerificationPromptInput = {
  previousResult: {
    bestMatch: string;
    confidenceScore: number; // 0-1
    confidenceBand: "low" | "medium" | "high";
    reasoning: string | null;
    alternatives: { label: string; confidence: number }[];
  };
  hallmark: { matchedLabel: string | null; marks: string[] } | null;
  answers: VerificationAnswers;
  // Which extra photo angles were actually supplied, in the same order as the
  // image parts attached to the request — lets the model know what it's
  // looking at without guessing.
  imageLabels: string[];
  location: { lat: number; lng: number; label?: string } | null;
};

function answerLine(label: string, value: unknown): string {
  if (value === undefined || value === null || value === "") return `- ${label}: not provided`;
  return `- ${label}: ${value}`;
}

export function buildVerificationPrompt(input: VerificationPromptInput): string {
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

  const weightLine =
    answers.weightValue != null
      ? `- Weight: ${answers.weightValue} ${answers.weightUnit ?? "grams"}`
      : "- Weight: not provided";

  return `You are a senior gemologist performing a SECOND-STAGE expert verification for GemScan AI. \
A consumer app already ran an initial photo-based identification; you are now given that result PLUS \
structured physical test answers the user collected themselves, to reach a more careful, evidence-weighted \
conclusion. This applies to ANY potentially high-value gemstone (diamond, ruby, sapphire, emerald, \
alexandrite, spinel, tanzanite, opal, jadeite, Paraiba tourmaline, and others) — it is especially useful for \
distinguishing diamond from its common look-alikes and simulants (moissanite, white sapphire, cubic \
zirconia, quartz, glass), but is not limited to diamonds.

ORIGINAL SCAN RESULT:
- Best match: ${previousResult.bestMatch} (${(previousResult.confidenceScore * 100).toFixed(0)}% confidence, ${previousResult.confidenceBand} band)
- Original reasoning: ${previousResult.reasoning ?? "none recorded"}
- Alternatives considered: ${altsLine}
${hallmarkLine}
${locationLine}

USER-COLLECTED PHYSICAL TEST EVIDENCE (self-reported by the user, not lab-verified — weigh accordingly):
${answerLine("Scratches glass", answers.scratchesGlass)}
${answerLine("Scratches steel", answers.scratchesSteel)}
${answerLine("Scratched by another object", answers.scratchedByAnotherObject)}
${answerLine("Transparency", answers.transparency)}
${answerLine("Fire (dispersion) under light", answers.fire)}
${answerLine("Sparkle", answers.sparkle)}
${answerLine("Shape", answers.shape)}
${answerLine("Color", answers.color)}
${weightLine}
${answerLine("Magnet attraction", answers.magnetAttracts)}
${answerLine("Breath-fog clear time", answers.fogClearTime)}
${answerLine("UV light reaction", answers.uvReaction)}
${answerLine("Loupe inspection", answers.loupeInclusions)}

${imagesLine}

Weigh ALL of this evidence together (original scan + physical tests + new photos) to reach ONE final \
conclusion.

NEVER state that the gemstone is definitely genuine or definitely a specific species — you are working from \
user-reported field tests and photographs, not certified lab instruments. Always hedge appropriately: prefer \
wording like "Likely", "Possibly", "Strongly consistent with", "Evidence suggests", or "Professional laboratory \
confirmation recommended" rather than flat assertions. You are not a substitute for GIA/AGL/IGI certification \
or XRF/spectroscopic analysis.

List EVERY piece of evidence that supports your conclusion in "supportingEvidence", each explained clearly \
(e.g. "Hardness matches expected range — scratches glass but not steel", "Fire is very strong, consistent with \
this identification", "No bubbles observed under loupe inspection"). List EVERY piece of evidence that reduces \
confidence in "conflictingEvidence" (e.g. "Weight is lower than expected for this size", "Sparkle is weaker \
than typical"); if there is genuinely nothing conflicting, return an empty array — do not invent conflicts.

Also provide an "evidenceScore" (0-100): this is NOT the same as "confidence" — confidence is how sure you are \
about the specific identification, while evidenceScore reflects how strong, thorough, and internally consistent \
the COLLECTED EVIDENCE itself is (how many tests were actually performed vs. skipped/"not tested", whether the \
photos and physical tests agree with each other, whether results are unambiguous). Use these bands: 95-100 \
exceptional evidence, 85-94 strong evidence, 70-84 moderate evidence, 50-69 limited evidence, below 50 \
insufficient evidence (e.g. almost everything was skipped or answers contradict each other).

Recommend ONLY the specific next tests genuinely relevant to resolving remaining uncertainty, chosen from this \
fixed list — do not include irrelevant ones just to fill the list: "Thermal Diamond Tester", "Electrical \
Conductivity Test", "Refractive Index Test", "Specific Gravity Test", "UV Fluorescence Test", "Magnification \
(10x loupe)", "Microscope inspection", "Professional gemological laboratory", "GIA", "IGI", "Local certified \
gemologist". Return an empty array if the evidence is already strong enough that no further testing is needed.

Respond with ONLY minified JSON, no markdown, matching exactly this shape:
{"finalIdentification": string, "confidence": number between 0 and 1, \
"probability": string (short plain-language likelihood statement, e.g. "Likely (60-75%)"), \
"reasoning": string (why you reached this conclusion), \
"supportingEvidence": string[] (every specific reason that supports the conclusion, clearly explained), \
"conflictingEvidence": string[] (every specific reason that conflicts with it — empty array if none), \
"mostLikelyAlternatives": [{"label": string, "note": string}, ... up to 3 items], \
"recommendation": "likely_natural_diamond"|"likely_lab_diamond"|"likely_moissanite"|"likely_white_sapphire"|"likely_quartz"|"cannot_determine"|"needs_professional_testing", \
"estimatedMarketValue": string (brief qualitative description, e.g. "Low — common material" or "Potentially significant if confirmed natural — professional appraisal needed"; NEVER a specific price), \
"professionalTestingRecommended": boolean, \
"professionalTestingNote": string (empty string if not recommended), \
"evidenceScore": number between 0 and 100, \
"recommendedNextTests": string[] (only entries from the fixed list above that are actually relevant, empty array if none needed)}`;
}

const RECOMMENDATIONS: VerificationRecommendation[] = [
  "likely_natural_diamond",
  "likely_lab_diamond",
  "likely_moissanite",
  "likely_white_sapphire",
  "likely_quartz",
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

// Defensive by field, same spirit as orchestrate-scan/providers/promptShared.ts
// — a model omitting or mistyping any single field must never fail parsing of
// the rest of the verdict.
export function parseVerificationResponse(text: string): VerificationVerdict {
  const cleaned = text.trim().replace(/^```(json)?/i, "").replace(/```$/, "").trim();
  const parsed = JSON.parse(cleaned) as Record<string, unknown>;

  const recommendation = RECOMMENDATIONS.includes(parsed.recommendation as VerificationRecommendation)
    ? (parsed.recommendation as VerificationRecommendation)
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
    estimatedMarketValue: str(parsed.estimatedMarketValue),
    professionalTestingRecommended: parsed.professionalTestingRecommended === true,
    professionalTestingNote: str(parsed.professionalTestingNote),
    evidenceScore: clampScore(parsed.evidenceScore),
    recommendedNextTests: Array.isArray(parsed.recommendedNextTests)
      ? parsed.recommendedNextTests.map((s) => str(s)).filter(Boolean)
      : [],
  };
}
