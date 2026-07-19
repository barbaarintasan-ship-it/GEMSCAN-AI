// Unit tests for the Dual Explanation Modes synthesis step.
// Run with: deno test --allow-none supabase/functions/orchestrate-scan/explanationSynthesis.test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildExplanations } from "./explanationSynthesis.ts";
import type { FullAnalysis, ProviderResult } from "./providers/types.ts";

function analysis(overrides: Partial<FullAnalysis> = {}): FullAnalysis {
  return {
    simpleExplanation: "",
    expertExplanation: {
      mineralSpecies: "",
      variety: "",
      crystalSystem: "",
      chemicalComposition: "",
      mohsHardness: "",
      specificGravity: "",
      refractiveIndex: "",
      cleavage: "",
      fracture: "",
      luster: "",
      transparency: "",
      diagnosticCharacteristics: "",
      geologicalOrigin: "",
      commonTreatments: "",
      syntheticIndicators: "",
      commonImitations: "",
      confidenceReasoning: "",
      recommendedLabTests: "",
      marketDemand: "",
      wholesaleEstimate: "",
      retailEstimate: "",
      investmentConsiderations: "",
    },
    imageObservations: "",
    warnings: "",
    recommendations: "",
    ...overrides,
  };
}

function result(overrides: Partial<ProviderResult>): ProviderResult {
  return {
    provider: "test_provider",
    candidate: null,
    alternatives: [],
    reasoning: "",
    latencyMs: 0,
    ...overrides,
  };
}

Deno.test("buildExplanations: returns null when no result carries an analysis", () => {
  const results = [result({ provider: "gemini_vision", candidate: { label: "Amethyst", confidence: 0.9 } })];
  const weights = new Map([["gemini_vision", 1]]);

  assertEquals(buildExplanations("Amethyst", results, weights), null);
});

Deno.test("buildExplanations: picks the analysis from the provider whose label matches the ensemble winner", () => {
  const results = [
    result({
      provider: "gemini_vision",
      candidate: { label: "Quartz", confidence: 0.6 },
      analysis: analysis({ simpleExplanation: "This looks like quartz." }),
    }),
    result({
      provider: "openai_vision",
      candidate: { label: "Amethyst", confidence: 0.9 },
      analysis: analysis({ simpleExplanation: "This looks like amethyst." }),
    }),
  ];
  const weights = new Map([
    ["gemini_vision", 0.28],
    ["openai_vision", 0.28],
  ]);

  const explanations = buildExplanations("Amethyst", results, weights);

  assertEquals(explanations?.simpleExplanation, "This looks like amethyst.");
});

Deno.test("buildExplanations: when no provider's label matches the winner, falls back to the highest-weight analysis available", () => {
  const results = [
    result({
      provider: "gemini_vision",
      candidate: { label: "Quartz", confidence: 0.6 },
      analysis: analysis({ simpleExplanation: "gemini's take" }),
    }),
    result({
      provider: "openai_vision",
      candidate: { label: "Citrine", confidence: 0.5 },
      analysis: analysis({ simpleExplanation: "openai's take" }),
    }),
  ];
  const weights = new Map([
    ["gemini_vision", 0.28],
    ["openai_vision", 0.4],
  ]);

  // "Amethyst" won via geo-boost/alternatives even though no provider's TOP
  // candidate was labeled that — buildExplanations must not throw, and
  // should fall back to the highest-weight provider's analysis.
  const explanations = buildExplanations("Amethyst", results, weights);

  assertEquals(explanations?.simpleExplanation, "openai's take");
});

Deno.test("buildExplanations: ignores errored/abstained results even if they somehow carry an analysis", () => {
  const results = [
    result({
      provider: "gemini_vision",
      candidate: null,
      error: "timeout",
      analysis: analysis({ simpleExplanation: "should be ignored" }),
    }),
    result({
      provider: "openai_vision",
      candidate: { label: "Amethyst", confidence: 0.9 },
      analysis: analysis({ simpleExplanation: "the real answer" }),
    }),
  ];
  const weights = new Map([
    ["gemini_vision", 0.28],
    ["openai_vision", 0.28],
  ]);

  const explanations = buildExplanations("Amethyst", results, weights);

  assertEquals(explanations?.simpleExplanation, "the real answer");
});
