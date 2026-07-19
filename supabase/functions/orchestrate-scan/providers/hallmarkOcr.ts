// Hallmark OCR sub-pipeline.
//
// Deliberately NOT modeled as "just another vision guess" — jewelry/coin
// hallmarks are precise symbolic codes (assay office marks, fineness stamps,
// maker's marks) that either match a known reference record or don't. This
// adapter (a) transcribes any stamped marks from the macro photo, then
// (b) looks up each transcribed mark against `reference_hallmarks` (populated
// by backend sync jobs from licensed sources — see §03 Tier 1/2/3 sourcing),
// and only returns a candidate when it finds a real reference match.
//
// Uses Gemini purely as an OCR/transcription tool here (a narrow prompt), not
// as a general identification guess — that keeps this provider's confidence
// grounded in an actual reference-database hit rather than a model opinion.
import type { ProviderInput, ProviderResult, VisionProvider } from "./types.ts";
import { createAbstainResult, fetchImageAsBase64, fetchWithRetry } from "./promptShared.ts";

// Auto-updating alias — same rationale as geminiVision.ts: a pinned
// gemini-2.0-flash was retired by Google, which silently made this hallmark/coin
// OCR pipeline abstain on every scan. "gemini-flash-latest" tracks the newest GA
// flash model. Still overridable via the GEMINI_MODEL secret.
const GEMINI_MODEL = Deno.env.get("GEMINI_MODEL") ?? "gemini-flash-latest";

const APPLICABLE_CATEGORIES = ["jewelry", "coin", "hallmark", "precious_metal"];

export const hallmarkOcrProvider: VisionProvider = {
  name: "hallmark_ocr",
  // Weighted per-match at identify() time via the returned confidence; the
  // base weight here just governs how much this provider's vote counts
  // relative to the general vision models when it does return a match.
  baseWeight: 0.2,

  isApplicable: (input) => {
    if (input.specimenCategory && APPLICABLE_CATEGORIES.includes(input.specimenCategory)) {
      return true;
    }
    // Also run if the on-device hint smells like jewelry/coin even when the
    // user didn't pre-tag a category.
    const hint = input.onDeviceHint?.label?.toLowerCase() ?? "";
    return hint.includes("jewelry") || hint.includes("coin") || hint.includes("ring");
  },

  async identify(input: ProviderInput): Promise<ProviderResult> {
    const start = Date.now();
    const apiKey = Deno.env.get("GEMINI_API_KEY");
    if (!apiKey) {
      return createAbstainResult(
        "hallmark_ocr",
        start,
        "GEMINI_API_KEY not configured (required for OCR transcription)",
      );
    }

    // Prefer the macro close-up for reading small stamped marks; fall back to
    // whatever was captured if no macro angle exists.
    const targetImage =
      input.images.find((i) => i.angle === "macro") ?? input.images[0];
    if (!targetImage) {
      return createAbstainResult("hallmark_ocr", start, "No image available for hallmark transcription");
    }

    try {
      const { base64, mimeType } = await fetchImageAsBase64(targetImage.url);
      const res = await fetchWithRetry(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [
              {
                role: "user",
                parts: [
                  {
                    text:
                      "Transcribe ONLY any stamped/engraved marks, numbers, or symbols visible " +
                      "on this jewelry/coin item (e.g. fineness stamps like 925, 750, 18K; assay " +
                      "office symbols; maker's marks). Respond with ONLY minified JSON: " +
                      '{"marks": string[]}. If nothing legible is visible, return {"marks": []}.',
                  },
                  { inline_data: { mime_type: mimeType, data: base64 } },
                ],
              },
            ],
            generationConfig: { temperature: 0, responseMimeType: "application/json" },
          }),
        },
      );

      const raw = await res.json();
      if (!res.ok) {
        throw new Error(raw?.error?.message ?? `Gemini OCR error (status ${res.status})`);
      }

      const text = raw?.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
      const { marks } = JSON.parse(text) as { marks?: string[] };

      if (!marks || marks.length === 0) {
        return {
          provider: "hallmark_ocr",
          candidate: null,
          alternatives: [],
          reasoning: "No legible stamped marks found in the macro photo.",
          latencyMs: Date.now() - start,
          raw,
        };
      }

      const matches = await lookupHallmarks(input, marks);
      if (matches.length === 0) {
        return {
          provider: "hallmark_ocr",
          candidate: null,
          alternatives: [],
          reasoning: `Transcribed mark(s) "${marks.join(", ")}" but found no matching reference record.`,
          latencyMs: Date.now() - start,
          raw: { marks },
        };
      }

      const [best, ...rest] = matches;
      return {
        provider: "hallmark_ocr",
        candidate: { label: best.label, confidence: best.confidence },
        alternatives: rest.map((m) => ({ label: m.label, confidence: m.confidence })),
        reasoning: `Transcribed mark "${best.matchedMark}" matched a known hallmark reference record.`,
        latencyMs: Date.now() - start,
        raw: { marks, matches },
      };
    } catch (err) {
      return createAbstainResult("hallmark_ocr", start, (err as Error).message);
    }
  },
};

// `reference_hallmarks` is populated by backend sync jobs and changes rarely
// (see header comment), while the same handful of marks (925, 750, 18K, ...)
// recur across many unrelated scans. Supabase Edge Function isolates stay
// warm across nearby invocations, so a small module-scope cache genuinely
// saves a repeat DB round-trip per warm invocation — performance only, never
// consulted for the actual AI identification confidence/weighting logic.
const HALLMARK_CACHE_MAX_ENTRIES = 500;
const hallmarkLookupCache = new Map<
  string,
  { label: string; confidence: number; matchedMark: string }[]
>();

function cacheHallmarkLookup(
  key: string,
  value: { label: string; confidence: number; matchedMark: string }[],
): void {
  // Simple insertion-order eviction (Map preserves insertion order): once at
  // capacity, drop the oldest entry rather than growing unbounded.
  if (hallmarkLookupCache.size >= HALLMARK_CACHE_MAX_ENTRIES) {
    const oldestKey = hallmarkLookupCache.keys().next().value;
    if (oldestKey !== undefined) hallmarkLookupCache.delete(oldestKey);
  }
  hallmarkLookupCache.set(key, value);
}

export async function lookupHallmarks(
  input: ProviderInput,
  marks: string[],
): Promise<{ label: string; confidence: number; matchedMark: string }[]> {
  const results: { label: string; confidence: number; matchedMark: string }[] = [];

  for (const mark of marks) {
    const normalized = mark.trim();
    if (!normalized) continue;

    const cacheKey = normalized.toLowerCase();
    const cached = hallmarkLookupCache.get(cacheKey);
    if (cached) {
      results.push(...cached);
      continue;
    }

    const { data, error } = await input.serviceClient
      .from("reference_hallmarks")
      .select("mark_code, country, assay_office, metal_type, fineness, period_start, period_end")
      .ilike("mark_code", `%${normalized}%`)
      .limit(3);

    if (error || !data) continue;

    const matchesForMark: { label: string; confidence: number; matchedMark: string }[] = [];
    for (const row of data) {
      const exact = row.mark_code.toLowerCase() === normalized.toLowerCase();
      const label = [row.metal_type, row.fineness, row.assay_office, row.country]
        .filter(Boolean)
        .join(" · ");
      matchesForMark.push({
        label: label || row.mark_code,
        confidence: exact ? 0.9 : 0.55,
        matchedMark: normalized,
      });
    }
    cacheHallmarkLookup(cacheKey, matchesForMark);
    results.push(...matchesForMark);
  }

  return results.sort((a, b) => b.confidence - a.confidence);
}
