// Unit tests for the shared identification prompt — specifically the
// language-instruction fix: the AI must be told to write its narrative
// explanation text in the app's display language, while the identification
// `label`/`alternatives[].label` always stay in canonical English/scientific
// form (so keyword matching, valuation lookups, and hallmark matching
// elsewhere in the app keep working unchanged).
// Run with: deno test --allow-none supabase/functions/orchestrate-scan/providers/promptShared.test.ts
import { assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildIdentificationPrompt } from "./promptShared.ts";
import type { ProviderInput } from "./types.ts";

function baseInput(overrides: Partial<ProviderInput> = {}): ProviderInput {
  return {
    scanId: "scan-1",
    images: [{ angle: "front", url: "https://signed.example/front.jpg" }],
    specimenCategory: null,
    onDeviceHint: null,
    location: null,
    explanationStyle: "simple",
    lang: "en",
    // deno-lint-ignore no-explicit-any
    serviceClient: {} as any,
    ...overrides,
  };
}

Deno.test("buildIdentificationPrompt: defaults to English with an explicit, forceful instruction", () => {
  const prompt = buildIdentificationPrompt(baseInput({ lang: "en" }));
  assertStringIncludes(prompt, "in clear, natural ENGLISH");
  // The English instruction is deliberately just as explicit/forceful as the
  // Somali one below (naming every field, an explicit "Do NOT" counter-
  // instruction) — a short generic "write in English" sentence was found to
  // be followed less reliably by the model than the longer Somali branch,
  // especially when the location hint points to a Somali-speaking region.
  assertStringIncludes(prompt, "Do NOT write these fields in Somali or any other language");
  assertStringIncludes(prompt, "reasoning");
  assertStringIncludes(prompt, "simpleExplanation");
});

Deno.test("buildIdentificationPrompt: instructs Somali narrative text when lang is 'so'", () => {
  const prompt = buildIdentificationPrompt(baseInput({ lang: "so" }));
  assertStringIncludes(prompt, "in clear, natural SOMALI");
  assertStringIncludes(prompt, "reasoning");
  assertStringIncludes(prompt, "simpleExplanation");
  assertStringIncludes(prompt, "imageObservations");
  assertStringIncludes(prompt, "warnings");
  assertStringIncludes(prompt, "recommendations");
});

Deno.test("buildIdentificationPrompt: tells the model to keep label/alternatives in English even in Somali mode", () => {
  const prompt = buildIdentificationPrompt(baseInput({ lang: "so" }));
  assertStringIncludes(
    prompt,
    'The "label" field and every "alternatives[].label" field must STILL be the specimen\'s',
  );
  assertStringIncludes(prompt, "never translate");
});

Deno.test("buildIdentificationPrompt: gives an example Somali gloss pattern for technical terms", () => {
  const prompt = buildIdentificationPrompt(baseInput({ lang: "so" }));
  assertStringIncludes(prompt, "Tusmada jabinta iftiinka (Refractive Index)");
});

Deno.test("buildIdentificationPrompt: English mode contains no Somali-language instruction block", () => {
  const prompt = buildIdentificationPrompt(baseInput({ lang: "en" }));
  // The English branch must not accidentally include the Somali-only instructions.
  const hasSomaliInstruction = prompt.includes("in clear, natural SOMALI");
  if (hasSomaliInstruction) {
    throw new Error("English-language prompt unexpectedly included the Somali instruction block");
  }
});
