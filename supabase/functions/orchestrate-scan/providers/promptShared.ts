// Shared helpers used by every cloud vision provider adapter.
import type { ProviderInput, ProviderResult } from "./types.ts";

// The same identification prompt (adapted per-vendor for message format) is
// sent to every general-purpose vision model, so their outputs are as
// comparable as possible for the ensemble stage. Each model is explicitly
// told to abstain rather than guess, and to always return machine-parseable
// JSON — never prose — so index.ts never depends on fragile text parsing.
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

  return `You are a gemology/mineralogy/numismatics identification assistant for GemScan AI, \
a consumer app for identifying NATURALLY OCCURRING or otherwise physical specimens: \
gemstones, minerals, rocks, crystals, meteorites, precious metals, jewelry, coins, and hallmarks.

You are given ${input.images.length} photos of the SAME physical specimen, taken from these \
angles: ${angles}.
${categoryHint}
${onDeviceHint}
${locationHint}

Identify the specimen. If you are not reasonably confident, DO NOT GUESS — return a low \
confidence and say so in your reasoning. Do not claim certified appraisal-grade certainty; \
you are not a substitute for GIA/AGL certification, XRF analysis, or treatment/synthetic \
detection, and you must not attempt to determine natural-vs-synthetic origin.

Respond with ONLY minified JSON, no markdown, matching exactly this shape:
{"label": string, "confidence": number between 0 and 1, "reasoning": string (1-3 sentences), \
"alternatives": [{"label": string, "confidence": number}, ... up to 4 items]}`;
}

export function parseJsonCandidateResponse(text: string): {
  label: string;
  confidence: number;
  reasoning: string;
  alternatives: { label: string; confidence: number }[];
} {
  // Models occasionally wrap JSON in a code fence despite instructions;
  // strip that defensively before parsing.
  const cleaned = text.trim().replace(/^```(json)?/i, "").replace(/```$/, "").trim();
  const parsed = JSON.parse(cleaned);
  return {
    label: String(parsed.label ?? "unknown"),
    confidence: clamp01(Number(parsed.confidence ?? 0)),
    reasoning: String(parsed.reasoning ?? ""),
    alternatives: Array.isArray(parsed.alternatives)
      ? parsed.alternatives
          .slice(0, 4)
          .map((a: { label?: unknown; confidence?: unknown }) => ({
            label: String(a?.label ?? "unknown"),
            confidence: clamp01(Number(a?.confidence ?? 0)),
          }))
      : [],
  };
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
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
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch image for provider (status ${res.status})`);
  }
  const mimeType = res.headers.get("content-type") ?? "image/jpeg";
  const buffer = new Uint8Array(await res.arrayBuffer());
  let binary = "";
  for (let i = 0; i < buffer.length; i++) binary += String.fromCharCode(buffer[i]);
  return { base64: btoa(binary), mimeType };
}
