// Shared helpers used by every cloud vision provider adapter.
import type { ExpertAnalysis, FullAnalysis, ProviderInput, ProviderResult } from "./types.ts";

// The same identification prompt (adapted per-vendor for message format) is
// sent to every general-purpose vision model, so their outputs are as
// comparable as possible for the ensemble stage. Each model is explicitly
// told to abstain rather than guess, and to always return machine-parseable
// JSON — never prose — so index.ts never depends on fragile text parsing.
//
// Dual Explanation Modes (see 03-AI-Architecture-and-Data-Sources.md): every
// model is asked to write BOTH a Simple (beginner-friendly) and an Expert
// (full gemological report) explanation on every call, regardless of the
// user's preference — that's what lets History/PDF switch between modes
// later without a re-scan. The user's actual preference just decides which
// one gets the model's primary depth and care.
export function buildIdentificationPrompt(input: ProviderInput): string {
  const angles = input.images.map((i) => i.angle).join(", ");
  const categoryHint = input.specimenCategory
    ? `The user tagged this as category: ${input.specimenCategory}.`
    : "No category was pre-selected by the user.";
  const onDeviceHint = input.onDeviceHint
    ? `An on-device coarse classifier suggests "${input.onDeviceHint.label}" ` +
      `(confidence ${input.onDeviceHint.confidence.toFixed(2)}). Treat this as a weak ` +
      `hint only, not ground truth.`
    : "No on-device classifier hint is available.";
  const locationHint = input.location
    ? `Approximate find location: lat ${input.location.lat}, lng ${input.location.lng}` +
      (input.location.label ? ` (${input.location.label})` : "") +
      `. You may use this to favor geologically/geographically plausible candidates.`
    : "No location was supplied.";
  const preferredStyle = input.explanationStyle === "expert" ? "Expert" : "Simple";
  const isSomali = input.lang === "so";

  // Every NARRATIVE/prose field (reasoning, simpleExplanation, expertExplanation's
  // prose fields, imageObservations, warnings, recommendations) must be written
  // in the app's display language. The identification `label`/`alternatives[].label`
  // are deliberately EXCLUDED from this — they stay in canonical scientific/English
  // form no matter the language, because the rest of the app (keyword matching,
  // market-value lookups, hallmark matching, PDF/report generation) depends on
  // that label being stable and comparable across scans.
  const languageInstruction = isSomali
    ? `Write ALL narrative/explanation text — "reasoning", "simpleExplanation", every prose field \
inside "expertExplanation" (mineralSpecies/variety may keep the scientific name, but \
diagnosticCharacteristics/geologicalOrigin/commonTreatments/syntheticIndicators/commonImitations/\
confidenceReasoning/recommendedLabTests/marketDemand/wholesaleEstimate/retailEstimate/\
investmentConsiderations must be full Somali sentences), "imageObservations", "warnings", and \
"recommendations" — in clear, natural SOMALI. Do NOT write these fields in English. \
Short technical values that are language-agnostic (e.g. "mohsHardness": "7", \
"chemicalComposition": "SiO2", "refractiveIndex": "1.54-1.55") may stay as their standard \
scientific notation. When using a technical/scientific term that has no natural Somali \
equivalent, keep the international term and add a brief Somali gloss in parentheses, e.g. \
"Tusmada jabinta iftiinka (Refractive Index)" or "Cufnaanta gaarka ah (Specific Gravity)". \
The "label" field and every "alternatives[].label" field must STILL be the specimen's \
canonical scientific/common name in English (e.g. "Quartz", "Diamond") — never translate \
those two fields, even though everything else is in Somali.`
    : `Write ALL narrative/explanation text — "reasoning", "simpleExplanation", every prose field \
inside "expertExplanation", "imageObservations", "warnings", and "recommendations" — in clear, \
natural ENGLISH. Do NOT write these fields in Somali or any other language, even if the location \
hint above points to Somalia or a Somali-speaking region — the find location does not change what \
language to write in. Short technical values that are language-agnostic (e.g. "mohsHardness": "7", \
"chemicalComposition": "SiO2", "refractiveIndex": "1.54-1.55") stay as their standard scientific \
notation regardless.`;

  return `You are a gemology/mineralogy/numismatics identification assistant for GemScan AI, \
a consumer app for identifying NATURALLY OCCURRING or otherwise physical specimens: \
gemstones, minerals, rocks, crystals, meteorites, precious metals, jewelry, coins, and hallmarks.

You are given ${input.images.length} photos of the SAME physical specimen, taken from these \
angles: ${angles}.
${categoryHint}
${onDeviceHint}
${locationHint}

Identify the specimen. If you are not reasonably confident, DO NOT GUESS — say so in your \
reasoning and list the genuine possibilities in "alternatives" instead. Do not claim certified \
appraisal-grade certainty; you are not a substitute for GIA/AGL certification, XRF analysis, or \
treatment/synthetic detection, and you must not attempt to determine natural-vs-synthetic origin.

DO NOT output any confidence, probability, certainty or percentage value anywhere in your \
response — not as a field, not inside your prose. Our system computes confidence itself from the \
agreement between independent analyses, image quality and evidence; a self-reported number is \
not measurable and is therefore ignored. Your job is to report WHAT YOU SEE and WHICH minerals \
are consistent with it. List "alternatives" in order, most likely first, whenever more than one \
mineral genuinely fits — an honest alternatives list is far more useful to us than a single \
forced answer.

${languageInstruction}

The user's preferred explanation style for this scan is: ${preferredStyle}. Write BOTH \
"simpleExplanation" and "expertExplanation" below regardless — the app may let the user switch \
views later — but give the ${preferredStyle} one your most depth and care.

For "simpleExplanation": write as if explaining to a curious 12-year-old with no gemology \
background, in plain, everyday language, 4-8 short sentences. Cover: what this object probably \
is, why you think that (in simple terms), whether it's common or rare, whether it might be \
valuable, whether extra testing is recommended, one simple care tip, and — if you are not very \
confident — a simple warning about that uncertainty.

For "expertExplanation": write for gemologists, collectors, dealers, and jewelry professionals, \
using proper technical terminology, no oversimplification. Fill in every field below as \
accurately as you can from the photos; if a field genuinely cannot be determined from images \
alone, say so briefly (e.g. "requires XRF" or "not determinable from photographs") rather than \
inventing a number.

Respond with ONLY minified JSON, no markdown, matching exactly this shape:
{"label": string, "reasoning": string (1-3 sentences), \
"alternatives": [{"label": string}, ... up to 4 items, ordered most likely first], \
"simpleExplanation": string, \
"expertExplanation": {"mineralSpecies": string, "variety": string, "crystalSystem": string, \
"chemicalComposition": string, "mohsHardness": string, "specificGravity": string, \
"refractiveIndex": string, "cleavage": string, "fracture": string, "luster": string, \
"transparency": string, "diagnosticCharacteristics": string, "geologicalOrigin": string, \
"commonTreatments": string, "syntheticIndicators": string, "commonImitations": string, \
"confidenceReasoning": string, "recommendedLabTests": string, "marketDemand": string, \
"wholesaleEstimate": string, "retailEstimate": string, "investmentConsiderations": string}, \
"imageObservations": string (what visual features you recognized in the photos), \
"warnings": string (caution/uncertainty notes, empty string if none), \
"recommendations": string (suggested next steps, e.g. additional testing)}`;
}

export function parseJsonCandidateResponse(text: string): {
  label: string;
  reasoning: string;
  alternatives: { label: string }[];
  analysis: FullAnalysis;
} {
  // Models occasionally wrap JSON in a code fence despite instructions;
  // strip that defensively before parsing.
  const cleaned = text.trim().replace(/^```(json)?/i, "").replace(/```$/, "").trim();
  const parsed = JSON.parse(cleaned);
  // NOTE: any `confidence` a model emits anyway is deliberately DISCARDED here.
  // Confidence is computed from evidence in ensemble.ts (the decision engine),
  // never taken from the model — a self-reported number is not measurable and
  // was the source of the same specimen scoring 88% once and 50% later.
  return {
    label: String(parsed.label ?? "unknown"),
    reasoning: String(parsed.reasoning ?? ""),
    alternatives: Array.isArray(parsed.alternatives)
      ? parsed.alternatives
          .slice(0, 4)
          .map((a: { label?: unknown }) => ({ label: String(a?.label ?? "unknown") }))
          .filter((a: { label: string }) => a.label && a.label !== "unknown")
      : [],
    analysis: parseFullAnalysis(parsed),
  };
}

// Defensive by field: a model omitting/mistyping any single field (or the
// whole expertExplanation object) must never fail parsing of the rest of the
// response — it just falls back to an empty string for that field.
function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function parseExpertAnalysis(v: unknown): ExpertAnalysis {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  return {
    mineralSpecies: str(o.mineralSpecies),
    variety: str(o.variety),
    crystalSystem: str(o.crystalSystem),
    chemicalComposition: str(o.chemicalComposition),
    mohsHardness: str(o.mohsHardness),
    specificGravity: str(o.specificGravity),
    refractiveIndex: str(o.refractiveIndex),
    cleavage: str(o.cleavage),
    fracture: str(o.fracture),
    luster: str(o.luster),
    transparency: str(o.transparency),
    diagnosticCharacteristics: str(o.diagnosticCharacteristics),
    geologicalOrigin: str(o.geologicalOrigin),
    commonTreatments: str(o.commonTreatments),
    syntheticIndicators: str(o.syntheticIndicators),
    commonImitations: str(o.commonImitations),
    confidenceReasoning: str(o.confidenceReasoning),
    recommendedLabTests: str(o.recommendedLabTests),
    marketDemand: str(o.marketDemand),
    wholesaleEstimate: str(o.wholesaleEstimate),
    retailEstimate: str(o.retailEstimate),
    investmentConsiderations: str(o.investmentConsiderations),
  };
}

function parseFullAnalysis(parsed: Record<string, unknown>): FullAnalysis {
  return {
    simpleExplanation: str(parsed.simpleExplanation),
    expertExplanation: parseExpertAnalysis(parsed.expertExplanation),
    imageObservations: str(parsed.imageObservations),
    warnings: str(parsed.warnings),
    recommendations: str(parsed.recommendations),
  };
}

// Every cloud vision provider needs to return the same "abstain with error"
// shape when it can't produce a candidate (missing API key, HTTP failure,
// timeout, malformed response, etc.) — shared here instead of each adapter
// defining its own identical local `abstain()` helper.
export function createAbstainResult(provider: string, start: number, error: string): ProviderResult {
  return {
    provider,
    candidate: null,
    alternatives: [],
    reasoning: "",
    latencyMs: Date.now() - start,
    error,
  };
}

// Gemini and Claude's image blocks need inline base64 bytes rather than a
// bare URL (unlike OpenAI's Chat Completions API, which accepts image URLs
// directly) — this fetches a signed Storage URL and base64-encodes it.
export async function fetchImageAsBase64(
  url: string,
): Promise<{ base64: string; mimeType: string }> {
  const res = await fetchWithRetry(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch image for provider (status ${res.status})`);
  }
  const mimeType = res.headers.get("content-type") ?? "image/jpeg";
  const buffer = new Uint8Array(await res.arrayBuffer());
  let binary = "";
  for (let i = 0; i < buffer.length; i++) binary += String.fromCharCode(buffer[i]);
  return { base64: btoa(binary), mimeType };
}

// One bounded retry for transient failures — a network-level error (thrown by
// fetch itself) or a 5xx from the vendor — never for 4xx, which means the
// request itself was rejected and a retry won't help. Naturally bounded by
// each provider's overall PROVIDER_TIMEOUT_MS race in index.ts's withTimeout,
// so this can only ever add one short, capped extra attempt, never stall the
// scan. Improves successful-identification rate on transient blips without
// touching any prompt, model choice, or scoring logic.
const RETRY_BACKOFF_MS = 300;

export async function fetchWithRetry(url: string, init?: RequestInit): Promise<Response> {
  try {
    const res = await fetch(url, init);
    if (res.status >= 500 && res.status < 600) {
      await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFF_MS));
      return await fetch(url, init);
    }
    return res;
  } catch {
    // Network-level failure (DNS, connection reset, etc.) — one retry after a
    // short fixed backoff, then let the caller's own error handling take over.
    await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFF_MS));
    return await fetch(url, init);
  }
}
