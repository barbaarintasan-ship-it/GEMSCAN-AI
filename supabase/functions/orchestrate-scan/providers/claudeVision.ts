// Anthropic Claude Vision adapter.
//
// Verify CLAUDE_MODEL against https://docs.anthropic.com/en/docs/about-claude/models
// before shipping.
import type { ProviderInput, ProviderResult, VisionProvider } from "./types.ts";
import {
  buildIdentificationPrompt,
  createAbstainResult,
  fetchImageAsBase64,
  parseJsonCandidateResponse,
} from "./promptShared.ts";

const CLAUDE_MODEL = Deno.env.get("CLAUDE_MODEL") ?? "claude-sonnet-4-6";
const ANTHROPIC_VERSION = "2023-06-01";

export const claudeVisionProvider: VisionProvider = {
  name: "claude_vision",
  baseWeight: 0.28,
  requiresEnsembleTier: true,
  isApplicable: (input) => input.images.length > 0,

  async identify(input: ProviderInput): Promise<ProviderResult> {
    const start = Date.now();
    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) {
      return createAbstainResult("claude_vision", start, "ANTHROPIC_API_KEY not configured");
    }

    try {
      const imageBlocks = await Promise.all(
        input.images.map(async (img) => {
          const { base64, mimeType } = await fetchImageAsBase64(img.url);
          return {
            type: "image",
            source: { type: "base64", media_type: mimeType, data: base64 },
          };
        }),
      );

      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model: CLAUDE_MODEL,
          // Was 512 — too small once the response also carries the full Dual
          // Explanation Modes payload (Simple + the ~20-field Expert report),
          // which silently truncated the JSON and failed parsing.
          max_tokens: 1800,
          temperature: 0.2,
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: buildIdentificationPrompt(input) }, ...imageBlocks],
            },
          ],
        }),
      });

      const raw = await res.json();
      if (!res.ok) {
        throw new Error(raw?.error?.message ?? `Claude API error (status ${res.status})`);
      }

      const text = raw?.content?.[0]?.text ?? "";
      const parsed = parseJsonCandidateResponse(text);

      return {
        provider: "claude_vision",
        candidate: { label: parsed.label, confidence: parsed.confidence },
        alternatives: parsed.alternatives,
        reasoning: parsed.reasoning,
        latencyMs: Date.now() - start,
        raw,
        analysis: parsed.analysis,
      };
    } catch (err) {
      return createAbstainResult("claude_vision", start, (err as Error).message);
    }
  },
};
