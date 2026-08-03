// Prompt + response parsing for the Artifact Verification final AI call.
// Deliberately independent of the scan pipeline and the diamond/gold
// verification prompts.
import type {
  ArtifactVerificationAnswers,
  ArtifactVerificationRecommendation,
  ArtifactVerificationVerdict,
} from "./types.ts";

export type ArtifactVerificationPromptInput = {
  previousResult: {
    bestMatch: string;
    confidenceScore: number; // 0-1
    confidenceBand: "low" | "medium" | "high";
    reasoning: string | null;
    alternatives: { label: string; confidence: number }[];
  };
  hallmark: { matchedLabel: string | null; marks: string[] } | null;
  answers: ArtifactVerificationAnswers;
  imageLabels: string[];
  location: { lat: number; lng: number; label?: string } | null;
};

function answerLine(label: string, value: unknown): string {
  if (value === undefined || value === null || value === "") return `- ${label}: not provided`;
  return `- ${label}: ${value}`;
}

export function buildVerificationPrompt(input: ArtifactVerificationPromptInput): string {
  const { previousResult, hallmark, answers, imageLabels, location } = input;

  const altsLine = previousResult.alternatives.length
    ? previousResult.alternatives.map((a) => `${a.label} (${(a.confidence * 100).toFixed(0)}%)`).join(", ")
    : "none";

  const hallmarkLine = hallmark
    ? `OCR of stamps/marks: ${hallmark.matchedLabel ?? "no reference match"}${
        hallmark.marks.length ? ` (transcribed marks: ${hallmark.marks.join(", ")})` : ""
      }.`
    : "No stamp/mark OCR data available.";

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
  const sizeLine =
    answers.approxSizeCm != null ? `- Approximate largest dimension: ${answers.approxSizeCm} cm` : "- Approximate size: not provided";

  return `You are a senior museum-trained antiquities specialist performing a SECOND-STAGE evidence-based \
verification for GemScan AI. A consumer app already ran an initial photo-based identification; you are now given \
that result PLUS structured questions the finder answered and any extra photos, to reach a more careful, \
evidence-weighted conclusion about what this object is, roughly when/where it may be from, and — critically — \
whether it is a GENUINE antiquity, a common historical item, a modern reproduction, a tourist replica/souvenir, \
or actually a natural (non-man-made) object mistaken for an artifact.

ORIGINAL SCAN RESULT:
- Best match: ${previousResult.bestMatch} (${(previousResult.confidenceScore * 100).toFixed(0)}% confidence, ${previousResult.confidenceBand} band)
- Original reasoning: ${previousResult.reasoning ?? "none recorded"}
- Alternatives considered: ${altsLine}
${hallmarkLine}
${locationLine}

FINDER-REPORTED CONTEXT (self-reported, not verified — weigh accordingly):
${answerLine("Where it was found", answers.foundLocation)}
${answerLine("Buried in the ground?", answers.buriedInGround)}
${answerLine("Found together with other objects?", answers.foundWithOtherObjects)}
${answerLine("Note about the other objects", answers.otherObjectsNote)}
${answerLine("Has it been cleaned?", answers.cleaned)}
${answerLine("Apparent material", answers.material)}
${answerLine("Condition", answers.condition)}
${answerLine("Visible inscriptions/marks?", answers.hasInscriptions)}
${weightLine}
${sizeLine}
${answerLine("Finder's age claim / what they were told", answers.ageClaim)}

${imagesLine}

Weigh ALL of this evidence together (original scan + find context + photos + any inscription OCR) to reach ONE \
final conclusion.

NEVER state that the object is definitely a genuine antiquity of a specific date or origin — you are working from \
photographs and a finder's unverified account, not hands-on examination, material dating, or provenance research. \
Always hedge appropriately: prefer "Likely", "Possibly", "Consistent with", "Appears to be", "Professional \
examination required to confirm". Modern reproductions, tourist souvenirs, and natural objects are extremely \
common and must be actively considered — surface wear, casting seams, artificially-applied patina, machine-made \
regularity, and "too clean/too perfect" condition are all signals of a modern item; explain them when present.

List EVERY piece of evidence that supports your conclusion in "supportingEvidence", each explained clearly. List \
EVERY piece that reduces confidence in "conflictingEvidence" (empty array if genuinely none — do not invent \
conflicts).

Provide "estimatedEra" (a hedged period, e.g. "Possibly 1st–3rd century CE" or "Modern — likely last 50 years") \
and "estimatedCulture" (a hedged cultural/regional attribution, or "Undetermined"). If any inscription/mark is \
visible in the photos, transcribe and, if possible, tentatively interpret it in "inscriptionReading" (empty \
string if none).

Also provide an "evidenceScore" (0-100): NOT the same as "confidence". Confidence is how sure you are of the \
identification; evidenceScore reflects how strong, thorough, and internally consistent the COLLECTED EVIDENCE \
itself is (how much find-context was given, how many informative photos, whether inscription/material/context \
agree). Bands: 95-100 exceptional, 85-94 strong, 70-84 moderate, 50-69 limited, below 50 insufficient.

"estimatedMarketValue": a brief QUALITATIVE descriptor only (e.g. "Low — common mass-produced type" or "Potentially \
significant IF authenticity and legal provenance are professionally established"). NEVER give a specific price or \
price range.

"heritageLegalNote" (ALWAYS fill this, never leave empty): a clear, non-alarmist caution that archaeological/\
cultural artifacts are legally protected in many countries (including Somalia), that removing objects from \
archaeological sites and selling or exporting antiquities may be illegal without authorization, that undocumented \
excavation destroys the historical value, and that a genuine-looking find should be reported to a museum, \
university archaeology department, or the national heritage/antiquities authority. Tailor the emphasis to the \
verdict (stronger when it looks like a genuine antiquity; lighter when it's clearly a modern replica).

Recommend concrete next steps in "recommendedNextSteps", chosen from this fixed list only: "Museum curator", \
"University archaeology department", "National heritage / antiquities authority", "Professional antiquities \
appraiser", "Thermoluminescence dating (ceramics)", "Radiocarbon dating (organic)", "XRF metal analysis", \
"Numismatic specialist (coins)", "Epigrapher (inscriptions)". Empty array only if the object is clearly a \
modern/natural item needing nothing further.

Respond with ONLY minified JSON, no markdown, matching exactly this shape:
{"finalIdentification": string, "confidence": number between 0 and 1, \
"probability": string, "reasoning": string, \
"supportingEvidence": string[], "conflictingEvidence": string[], \
"mostLikelyAlternatives": [{"label": string, "note": string}, ... up to 3], \
"recommendation": "likely_genuine_antiquity"|"likely_historical_but_common"|"likely_modern_reproduction"|"likely_replica_or_souvenir"|"likely_natural_object_not_artifact"|"cannot_determine"|"needs_professional_examination", \
"estimatedEra": string, "estimatedCulture": string, "inscriptionReading": string, \
"estimatedMarketValue": string (qualitative, NEVER a number), \
"professionalExaminationRecommended": boolean, "professionalExaminationNote": string, \
"heritageLegalNote": string (ALWAYS non-empty), \
"evidenceScore": number between 0 and 100, \
"recommendedNextSteps": string[]}`;
}

const RECOMMENDATIONS: ArtifactVerificationRecommendation[] = [
  "likely_genuine_antiquity",
  "likely_historical_but_common",
  "likely_modern_reproduction",
  "likely_replica_or_souvenir",
  "likely_natural_object_not_artifact",
  "cannot_determine",
  "needs_professional_examination",
];

function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function clamp01(n: unknown): number {
  const v = Number(n);
  if (Number.isNaN(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

function clampScore(n: unknown): number {
  const v = Number(n);
  if (Number.isNaN(v)) return 0;
  return Math.max(0, Math.min(100, Math.round(v)));
}

// Defensive by field — a model omitting or mistyping any single field must
// never fail parsing of the rest of the verdict. heritageLegalNote falls back
// to a fixed safe default rather than "" so the report always carries a
// heritage caution even if the model dropped the field.
const DEFAULT_HERITAGE_NOTE =
  "Archaeological and cultural artifacts are legally protected in many countries, including Somalia. Removing " +
  "objects from a site, or selling or exporting antiquities, may be illegal without official authorization, and " +
  "undocumented excavation destroys irreplaceable historical information. If this may be a genuine antiquity, " +
  "report it to a museum, a university archaeology department, or the national heritage authority before doing " +
  "anything else.";

export function parseVerificationResponse(text: string): ArtifactVerificationVerdict {
  const cleaned = text.trim().replace(/^```(json)?/i, "").replace(/```$/, "").trim();
  const parsed = JSON.parse(cleaned) as Record<string, unknown>;

  const recommendation = RECOMMENDATIONS.includes(parsed.recommendation as ArtifactVerificationRecommendation)
    ? (parsed.recommendation as ArtifactVerificationRecommendation)
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
    estimatedEra: str(parsed.estimatedEra),
    estimatedCulture: str(parsed.estimatedCulture),
    inscriptionReading: str(parsed.inscriptionReading),
    estimatedMarketValue: str(parsed.estimatedMarketValue),
    professionalExaminationRecommended: parsed.professionalExaminationRecommended === true,
    professionalExaminationNote: str(parsed.professionalExaminationNote),
    heritageLegalNote: str(parsed.heritageLegalNote) || DEFAULT_HERITAGE_NOTE,
    evidenceScore: clampScore(parsed.evidenceScore),
    recommendedNextSteps: Array.isArray(parsed.recommendedNextSteps)
      ? parsed.recommendedNextSteps.map((s) => str(s)).filter(Boolean)
      : [],
  };
}
