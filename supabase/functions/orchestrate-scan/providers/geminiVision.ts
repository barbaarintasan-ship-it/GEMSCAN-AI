// Google Gemini Vision adapter.
//
// Verify GEMINI_MODEL against https://ai.google.dev/gemini-api/docs/models
// before shipping — model names/versions change faster than this file does.
import type { ProviderInput, ProviderResult, VisionProvider } from "./types.ts";
import {
  buildIdentificationPrompt,
  createAbstainResult,
  fetchImageAsBase64,
  fetchWithRetry,
  parseJsonCandidateResponse,
} from "./promptShared.ts";

// Model selection is deliberately an auto-updating alias. Pinned versions
// (gemini-2.0-flash, gemini-2.5-flash) get retired or restricted to
// pre-existing users, which silently made every free-tier scan abstain (Gemini
// is the only cloud provider free users get). "gemini-flash-latest" always
// resolves to the newest GA flash model the API key can access. Still
// overridable via the GEMINI_MODEL secret if a specific pin is ever needed.
const GEMINI_MODEL = Deno.env.get("GEMINI_MODEL") ?? "gemini-flash-latest";

export const geminiVisionProvider: VisionProvider = {
  name: "gemini_vision",
  baseWeight: 0.28,
  isApplicable: (input) => input.images.length > 0,

  async identify(input: ProviderInput): Promise<ProviderResult> {
    const start = Date.now();
    const apiKey = Deno.env.get("GEMINI_API_KEY");
    if (!apiKey) {
      return createAbstainResult("gemini_vision", start, "GEMINI_API_KEY not configured");
    }

    try {
      const imageParts = await Promise.all(
        input.images.map(async (img) => {
          const { base64, mimeType } = await fetchImageAsBase64(img.url);
          return { inline_data: { mime_type: mimeType, data: base64 } };
        }),
      );

      const body = {
        contents: [
          {
            role: "user",
            parts: [{ text: buildIdentificationPrompt(input) }, ...imageParts],
          },
        ],
        generationConfig: { temperature: 0.2, responseMimeType: "application/json" },
      };

      const res = await fetchWithRetry(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
      );

      const raw = await res.json();
      if (!res.ok) {
        throw new Error(raw?.error?.message ?? `Gemini API error (status ${res.status})`);
      }

      const text = raw?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
      const parsed = parseJsonCandidateResponse(text);

      return {
        provider: "gemini_vision",
        candidate: { label: parsed.label, confidence: parsed.confidence },
        alternatives: parsed.alternatives,
        reasoning: parsed.reasoning,
        latencyMs: Date.now() - start,
        raw,
        analysis: parsed.analysis,
      };
    } catch (err) {
      return createAbstainResult("gemini_vision", start, (err as Error).message);
    }
  },
};
