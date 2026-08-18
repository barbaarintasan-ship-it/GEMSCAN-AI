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
  type FindingEvidence, type LanguageViolation, type MissionFindings,
} from "../../../../shared/geo-core/gie/missionFindings.ts";
import {
  buildMissionPrompt, parseMissionFindings, type EnginePackageSummary,
} from "./missionPrompt.ts";
import type { VisualObservation } from "./vision.ts";
import { visualObservationsToEvidence } from "./visionFindings.ts";
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
  /**
   * Read the mission's photographs and return what is VISUALLY observable.
   *
   * Injected so the analysis is testable without a key, a network, or R2 — and so a
   * vision FAILURE (it throws) degrades to a report with no visual section rather
   * than stranding the mission. Omitted → no visual evidence is added, exactly as
   * before this stage existed.
   */
  vision?: (photos: ReadonlyArray<{ id: string; key: string }>) => Promise<VisualObservation[]>;
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

  // ── 2b. VISION — read the photographs, as VISUAL EVIDENCE ONLY ─────────────
  //
  // Runs only once the photographs are confirmed in storage, so the model never
  // reads a URL that will not resolve. It is pure enrichment: a failure here — a
  // dead image, a resize error, a vision outage — yields an empty visual section
  // and the mission is still assessed on its geological evidence. It NEVER strands
  // the package, and (by visionFindings) it can never claim gold, a deposit, or
  // stand in for assay.
  let visualEvidence: FindingEvidence[] = [];
  if (photos.length > 0 && deps.vision) {
    try {
      const observations = await deps.vision(photos);
      visualEvidence = visualObservationsToEvidence(observations);
    } catch {
      visualEvidence = [];
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

  // ── 6b. Merge the visual evidence read from the photographs ────────────────
  //
  // Appended as its own photograph-origin rows, so the report's VISUAL EVIDENCE
  // section shows what the images revealed instead of "no photographs were read".
  // Each row is weak/low and unverified (visionFindings), so it enriches the
  // picture without ever letting a photo masquerade as assay.
  const withVisual: MissionFindings = visualEvidence.length > 0
    ? { ...clean, evidence: [...clean.evidence, ...visualEvidence] }
    : clean;

  // ── 7. Cap confidence to what the evidence actually supports ───────────────
  //
  // The model's original claim is KEPT when it is reduced. Capping and then
  // comparing in the renderer would destroy the fact being reported, and a
  // geologist is entitled to know the assessment was toned down.
  const ceiling = cappedConfidence(withVisual);
  const capped: MissionFindings = {
    ...withVisual,
    confidence: ceiling,
    ...(ceiling !== withVisual.confidence ? { claimedConfidence: withVisual.confidence } : {}),
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
  // gemini-2.0-flash was retired by Google — see orchestrate-scan/providers/
  // hallmarkOcr.ts and geminiVision.ts, which hit the same retirement and moved
  // to this alias. "gemini-flash-latest" tracks whatever the current GA flash
  // model is, so this file no longer drifts out of sync with the rest of the
  // Gemini call sites when Google retires a pinned version again.
  const model = Deno.env.get("GEMINI_MODEL") ?? "gemini-flash-latest";
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
            //
            // responseMimeType forces pure JSON (no markdown fences, no prose
            // preamble); the old `maxOutputTokens: 2048` cap is REMOVED because it
            // truncated the bilingual (EN + Somali) report mid-object, so
            // JSON.parse threw "response was not JSON" on every real mission.
            // MEASURED via diag-gemini on gemini-flash-latest: 2048/no-mime →
            // finishReason MAX_TOKENS, 2269 chars, unparseable; responseMimeType/
            // no-cap → STOP, 8735 chars, valid JSON. This is exactly what the
            // working siblings reasoning.ts and vision.ts already send.
            generationConfig: { temperature: 0.2, responseMimeType: "application/json" },
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
