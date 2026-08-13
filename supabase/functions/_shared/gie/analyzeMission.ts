// analyzeExplorationPackage — the one entry point for assessing a field mission.
//
// ORDER OF OPERATIONS, and every step is load-bearing:
//
//   1. is the package structurally complete?          → refuse if not
//   2. is EVERY photograph actually in R2?             → BLOCK if not
//   3. build the prompt from the engine's own readings
//   4. ask the provider
//   5. parse, discarding anything the model was not allowed to say
//   6. strip probability language from the prose
//   7. cap confidence to what the evidence supports
//
// Step 2 is the one most likely to be skipped under pressure and the one that
// matters most. A model handed nine of a mission's ten photographs writes a report
// that reads exactly like a complete one — same confidence, same conclusions, no
// indication that anything is absent. So analysis does not begin until the bytes
// have been seen. "The device said it uploaded" is not evidence.
//
// AI FAILURE MUST NOT DESTROY MISSION DATA. Every outcome here is a value, not an
// exception: a failed analysis leaves the package exactly as it was, ready to be
// retried, and the geologist's evidence is untouched either way.
import {
  cappedConfidence, isUsableFindings, withoutForbiddenNarrative,
  type LanguageViolation, type MissionFindings,
} from "../../../../shared/geo-core/gie/missionFindings.ts";
import {
  buildMissionPrompt, parseMissionFindings, type EnginePackageSummary,
} from "./missionPrompt.ts";
import {
  photosInPackage, summariseVerification, verifyObjects,
  type VerificationSummary,
} from "../r2/verify.ts";
import type { R2Config } from "../r2/sign.ts";

/** The swappable provider. Any reasoning model that returns text satisfies it. */
export interface AIProvider {
  /** A stable identifier stored with the report, so it can be re-read against its author. */
  readonly model: string;
  generate(prompt: string): Promise<string>;
}

export interface AnalyzeDeps {
  provider: AIProvider;
  /** Object storage, for the verification gate. Omit only in tests that skip it. */
  r2?: R2Config;
  /** Injected so verification is testable without a network. */
  verify?: (config: R2Config, keys: readonly string[]) => Promise<
    Awaited<ReturnType<typeof verifyObjects>>
  >;
  now?: () => number;
}

/**
 * Everything the analysis reads. The engine's summary plus the raw package, so the
 * photograph list can be checked against storage.
 */
export interface AnalyzeInput {
  engine: EnginePackageSummary;
  /** The package payload as the device assembled it, verbatim. */
  payload: {
    missionId?: string;
    observations?: Array<{ photos?: Array<{ id?: string }> }>;
  };
}

export type AnalyzeOutcome =
  | {
      status: "analysed";
      findings: MissionFindings;
      /** What the model tried to say and was not allowed to. Empty is the norm. */
      discarded: string[];
      violations: LanguageViolation[];
      verification: VerificationSummary | null;
    }
  | {
      status: "blocked";
      reason: "photos_not_in_storage";
      verification: VerificationSummary;
    }
  | {
      status: "refused";
      reason: "package_incomplete" | "storage_not_configured";
      detail: string;
    }
  | {
      status: "failed";
      /** The provider or the parse failed. The package is untouched and retryable. */
      reason: "provider_error" | "unparseable" | "empty_analysis";
      detail: string;
    };

export async function analyzeExplorationPackage(
  input: AnalyzeInput,
  deps: AnalyzeDeps,
): Promise<AnalyzeOutcome> {
  const now = deps.now ?? (() => Date.now());

  // ── 1. Is there a package at all? ─────────────────────────────────────────
  if (!input.engine?.missionId) {
    return { status: "refused", reason: "package_incomplete", detail: "no missionId" };
  }

  // ── 2. THE VERIFICATION GATE ───────────────────────────────────────────────
  const photos = photosInPackage(input.payload);
  let verification: VerificationSummary | null = null;
  if (photos.length > 0) {
    if (!deps.r2) {
      // Refusing, not proceeding. Analysing a mission whose photographs cannot be
      // checked would produce a report indistinguishable from a verified one.
      return {
        status: "refused",
        reason: "storage_not_configured",
        detail: `${photos.length} photograph(s) to verify and no storage configured`,
      };
    }
    const verify = deps.verify ?? verifyObjects;
    let results: Awaited<ReturnType<typeof verifyObjects>>;
    try {
      results = await verify(deps.r2, photos.map((p) => p.key));
    } catch (e) {
      // Could not tell. That is NOT "the photographs are missing" — failing a
      // mission because the network blinked would destroy real work.
      return {
        status: "failed",
        reason: "provider_error",
        detail: `verification unreachable: ${message(e)}`,
      };
    }
    verification = summariseVerification(photos, results);
    if (!verification.complete) {
      return { status: "blocked", reason: "photos_not_in_storage", verification };
    }
  }

  // ── 3–4. Ask the provider ─────────────────────────────────────────────────
  const prompt = buildMissionPrompt(input.engine);
  let text: string;
  try {
    text = await deps.provider.generate(prompt);
  } catch (e) {
    return { status: "failed", reason: "provider_error", detail: message(e) };
  }

  // ── 5. Parse, discarding what was not permitted ────────────────────────────
  const parsed = parseMissionFindings(text, {
    model: deps.provider.model,
    commodity: input.engine.commodity,
    analysedAt: now(),
  });
  if (!parsed.findings) {
    return {
      status: "failed",
      reason: "unparseable",
      detail: parsed.discarded.join("; ") || "no findings in response",
    };
  }

  // ── 6. Strip probability language from the prose ───────────────────────────
  const { findings: clean, violations } = withoutForbiddenNarrative(parsed.findings);

  // ── 7. Cap confidence to what the evidence actually supports ───────────────
  //
  // The model's original claim is KEPT when it is reduced. Capping and then
  // comparing in the renderer would destroy the fact being reported, and a
  // geologist is entitled to know the assessment was toned down.
  const ceiling = cappedConfidence(clean);
  const capped: MissionFindings = {
    ...clean,
    confidence: ceiling,
    ...(ceiling !== clean.confidence ? { claimedConfidence: clean.confidence } : {}),
  };

  // An analysis with nothing found AND no gaps named is not cautious, it is empty,
  // and shipping it would teach a geologist the app has an opinion where it has none.
  if (!isUsableFindings(capped)) {
    return {
      status: "failed",
      reason: "empty_analysis",
      detail: "no evidence and no stated gaps",
    };
  }

  return {
    status: "analysed",
    findings: capped,
    discarded: parsed.discarded,
    violations,
    verification,
  };
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * The provider the product uses.
 *
 * Gemini, matching the existing GIE path so there is one model configuration in the
 * system rather than two. Swapping it means passing a different `AIProvider` — that
 * is the whole reason the interface is one method wide.
 */
export function geminiProvider(): AIProvider {
  const model = Deno.env.get("GEMINI_MODEL") ?? "gemini-2.0-flash";
  return {
    model,
    async generate(prompt: string): Promise<string> {
      const apiKey = Deno.env.get("GEMINI_API_KEY");
      if (!apiKey) throw new Error("GEMINI_API_KEY not configured");
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            // Low temperature: this is an assessment, not prose generation, and a
            // creative reading of field evidence is the last thing anyone wants.
            generationConfig: { temperature: 0.2, maxOutputTokens: 2048 },
          }),
        },
      );
      if (!res.ok) throw new Error(`model returned ${res.status}`);
      const data = await res.json() as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      };
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error("model returned no text");
      return text;
    },
  };
}
