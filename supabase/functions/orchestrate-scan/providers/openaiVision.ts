// OpenAI GPT Vision adapter.
//
// Verify OPENAI_MODEL against https://platform.openai.com/docs/models before
// shipping. Unlike Gemini/Claude, the Chat Completions API accepts an image
// URL directly, so no base64 fetch/encode round-trip is needed here.
import type { ProviderInput, ProviderResult, VisionProvider } from "./types.ts";
import {
  buildIdentificationPrompt,
  createAbstainResult,
  parseJsonCandidateResponse,
} from "./promptShared.ts";

const OPENAI_MODEL = Deno.env.get("OPENAI_MODEL") ?? "gpt-4o-mini";

export const openaiVisionProvider: VisionProvider = {
  name: "openai_vision",
  baseWeight: 0.28,
  requiresEnsembleTier: true,
  isApplicable: (input) => input.images.length > 0,

  async identify(input: ProviderInput): Promise<ProviderResult> {
    const start = Date.now();
    const apiKey = Deno.env.get("OPENAI_API_KEY");
    if (!apiKey) {
      return createAbstainResult("openai_vision", start, "OPENAI_API_KEY not configured");
    }

    try {
      const content: Record<string, unknown>[] = [
        { type: "text", text: buildIdentificationPrompt(input) },
        ...input.images.map((img) => ({
          type: "image_url",
          image_url: { url: img.url },
        })),
      ];

      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: OPENAI_MODEL,
          temperature: 0.2,
          response_format: { type: "json_object" },
          messages: [{ role: "user", content }],
        }),
      });

      const raw = await res.json();
      if (!res.ok) {
        throw new Error(raw?.error?.message ?? `OpenAI API error (status ${res.status})`);
      }

      const text = raw?.choices?.[0]?.message?.content ?? "";
      const parsed = parseJsonCandidateResponse(text);

      return {
        provider: "openai_vision",
        candidate: { label: parsed.label, confidence: parsed.confidence },
        alternatives: parsed.alternatives,
        reasoning: parsed.reasoning,
        latencyMs: Date.now() - start,
        raw,
      };
    } catch (err) {
      return createAbstainResult("openai_vision", start, (err as Error).message);
    }
  },
};
