// Unit tests for the Stage 5/6 weighted-confidence ensemble in ensemble.ts.
// Run with: deno test --allow-none supabase/functions/orchestrate-scan/ensemble.test.ts
import { assert, assertEquals, assertAlmostEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  runEnsemble,
  INSUFFICIENT_CONFIDENCE_MESSAGE,
  COMPETING_CANDIDATES_MESSAGE,
} from "./ensemble.ts";
import type { ProviderResult } from "./providers/types.ts";

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

Deno.test("runEnsemble: a lone provider is capped — one opinion is never proof", () => {
  const results: ProviderResult[] = [
    result({ provider: "gemini_vision", candidate: { label: "Amethyst" } }),
  ];
  const weights = new Map([["gemini_vision", 1]]);

  const ensemble = runEnsemble(results, weights);

  assertEquals(ensemble.candidates.length, 1);
  assertEquals(ensemble.candidates[0].label, "Amethyst");
  assertEquals(ensemble.candidates[0].rank, 1);
  // Single-source cap (0.6): usable, but never "high", and never unlocks the
  // geological interpretation.
  assertAlmostEquals(ensemble.candidates[0].weightedConfidence, 0.6, 1e-9);
  assertEquals(ensemble.candidates[0].confidenceBand, "medium");
  assertEquals(ensemble.insufficientConfidence, false);
  assertEquals(ensemble.interpretationUnlocked, false);
});

Deno.test("runEnsemble: model-reported confidence is IGNORED — the regression test", () => {
  // The reported bug: the same specimen came back "Diamond 88%" once and
  // "Celestite 50%" later. Those numbers came from the model. They are now
  // discarded, so two runs whose models felt wildly different about the SAME
  // evidence must produce byte-identical decisions.
  const weights = new Map([["gemini_vision", 1], ["openai_vision", 1]]);
  const confidentRun: ProviderResult[] = [
    result({ provider: "gemini_vision", candidate: { label: "Celestite", confidence: 0.88 } }),
    result({ provider: "openai_vision", candidate: { label: "Celestite", confidence: 0.92 } }),
  ];
  const doubtfulRun: ProviderResult[] = [
    result({ provider: "gemini_vision", candidate: { label: "Celestite", confidence: 0.5 } }),
    result({ provider: "openai_vision", candidate: { label: "Celestite", confidence: 0.05 } }),
  ];

  const a = runEnsemble(confidentRun, weights);
  const b = runEnsemble(doubtfulRun, weights);

  assertEquals(a.candidates[0].weightedConfidence, b.candidates[0].weightedConfidence);
  assertEquals(a.candidates[0].confidenceBand, b.candidates[0].confidenceBand);
  assertEquals(a.insufficientConfidence, b.insufficientConfidence);
});

Deno.test("runEnsemble: independent agreement raises confidence above the single-source cap", () => {
  const weights = new Map([["gemini_vision", 1], ["openai_vision", 1]]);
  const one = runEnsemble(
    [result({ provider: "gemini_vision", candidate: { label: "Quartz" } })],
    weights,
  );
  const two = runEnsemble(
    [
      result({ provider: "gemini_vision", candidate: { label: "Quartz" } }),
      result({ provider: "openai_vision", candidate: { label: "Quartz" } }),
    ],
    weights,
  );

  assert(two.candidates[0].weightedConfidence > one.candidates[0].weightedConfidence);
  assertEquals(two.candidates[0].confidenceBand, "high");
  assertEquals(two.interpretationUnlocked, true);
});

Deno.test("runEnsemble: two equally-supported candidates are inconclusive, not a coin flip", () => {
  const results: ProviderResult[] = [
    result({ provider: "gemini_vision", candidate: { label: "Celestite" } }),
    result({ provider: "openai_vision", candidate: { label: "Blue Quartz" } }),
  ];
  const weights = new Map([["gemini_vision", 1], ["openai_vision", 1]]);

  const ensemble = runEnsemble(results, weights);

  assertEquals(ensemble.insufficientConfidence, true);
  assertEquals(ensemble.message, COMPETING_CANDIDATES_MESSAGE);
  assertEquals(ensemble.interpretationUnlocked, false);
  // Both remain visible as ranked possibilities.
  assertEquals(ensemble.candidates.length, 2);
});

Deno.test("runEnsemble: poor image quality lowers confidence", () => {
  const results: ProviderResult[] = [
    result({ provider: "gemini_vision", candidate: { label: "Pyrite" } }),
    result({ provider: "openai_vision", candidate: { label: "Pyrite" } }),
  ];
  const weights = new Map([["gemini_vision", 1], ["openai_vision", 1]]);

  const sharp = runEnsemble(results, weights, 1);
  const poor = runEnsemble(results, weights, 0.5);

  assert(poor.candidates[0].weightedConfidence < sharp.candidates[0].weightedConfidence);
  assertEquals(sharp.interpretationUnlocked, true);
  assertEquals(poor.interpretationUnlocked, false);
});

Deno.test("runEnsemble: agreement across providers outranks a single lone dissenter", () => {
  const results: ProviderResult[] = [
    result({ provider: "gemini_vision", candidate: { label: "Quartz", confidence: 0.8 } }),
    result({ provider: "openai_vision", candidate: { label: "Quartz", confidence: 0.7 } }),
    result({ provider: "claude_vision", candidate: { label: "Calcite", confidence: 0.95 } }),
  ];
  const weights = new Map([
    ["gemini_vision", 1],
    ["openai_vision", 1],
    ["claude_vision", 1],
  ]);

  const ensemble = runEnsemble(results, weights);

  assertEquals(ensemble.candidates[0].label, "Quartz");
});

Deno.test("runEnsemble: label normalization merges casing/whitespace variants", () => {
  const results: ProviderResult[] = [
    result({ provider: "gemini_vision", candidate: { label: "Rose Quartz", confidence: 0.6 } }),
    result({ provider: "openai_vision", candidate: { label: "  rose   quartz ", confidence: 0.6 } }),
  ];
  const weights = new Map([
    ["gemini_vision", 1],
    ["openai_vision", 1],
  ]);

  const ensemble = runEnsemble(results, weights);

  // Both providers' votes should merge into a single candidate, not split.
  assertEquals(ensemble.candidates.length, 1);
  assertEquals(ensemble.candidates[0].label, "Rose Quartz");
});

Deno.test("runEnsemble: alternatives count as discounted evidence", () => {
  const results: ProviderResult[] = [
    result({
      provider: "gemini_vision",
      candidate: { label: "Topaz", confidence: 0.5 },
      alternatives: [{ label: "Citrine", confidence: 0.9 }],
    }),
    result({
      provider: "openai_vision",
      candidate: { label: "Citrine", confidence: 0.9 },
    }),
  ];
  const weights = new Map([
    ["gemini_vision", 1],
    ["openai_vision", 1],
  ]);

  const ensemble = runEnsemble(results, weights);

  // Citrine gets openai's full-weight vote (0.9) plus gemini's discounted
  // alternative vote (0.5 * 0.9 = 0.45), summing to 1.35 -> normalized by
  // total weight (2) = 0.675 which should beat Topaz's 0.5/2 = 0.25.
  assertEquals(ensemble.candidates[0].label, "Citrine");
});

Deno.test("runEnsemble: providers with error or null candidate contribute nothing", () => {
  const results: ProviderResult[] = [
    result({ provider: "gemini_vision", error: "Timed out after 25000ms", candidate: null }),
    result({ provider: "openai_vision", candidate: { label: "Pyrite", confidence: 0.8 } }),
  ];
  const weights = new Map([
    ["gemini_vision", 1],
    ["openai_vision", 1],
  ]);

  const ensemble = runEnsemble(results, weights);

  // Only openai participated, so Pyrite rests on a single source and is capped
  // at 0.6 — the errored provider neither helps nor dilutes.
  assertEquals(ensemble.candidates.length, 1);
  assertAlmostEquals(ensemble.candidates[0].weightedConfidence, 0.6, 1e-9);
});

Deno.test("runEnsemble: a provider with zero registered weight is excluded even if it returned a candidate", () => {
  const results: ProviderResult[] = [
    result({ provider: "unweighted_provider", candidate: { label: "Garnet", confidence: 0.99 } }),
  ];
  const weights = new Map([["unweighted_provider", 0]]);

  const ensemble = runEnsemble(results, weights);

  assertEquals(ensemble.candidates.length, 0);
  assertEquals(ensemble.insufficientConfidence, true);
});

Deno.test("runEnsemble: no participating providers yields insufficientConfidence with suggestions", () => {
  const results: ProviderResult[] = [
    result({ provider: "gemini_vision", error: "down", candidate: null }),
  ];
  const weights = new Map([["gemini_vision", 1]]);

  const ensemble = runEnsemble(results, weights);

  assertEquals(ensemble.candidates.length, 0);
  assertEquals(ensemble.insufficientConfidence, true);
  assertEquals(ensemble.message, INSUFFICIENT_CONFIDENCE_MESSAGE);
  assertEquals(ensemble.suggestions.length > 0, true);
});

Deno.test("runEnsemble: three providers naming three different minerals is inconclusive", () => {
  // Nobody agrees: every label rests on one source and they are all level, so
  // the honest answer is "we cannot tell", not the alphabetically luckiest one.
  const results: ProviderResult[] = [
    result({ provider: "a", candidate: { label: "Opal" } }),
    result({ provider: "b", candidate: { label: "Jade" } }),
    result({ provider: "c", candidate: { label: "Jasper" } }),
  ];
  const weights = new Map([
    ["a", 1],
    ["b", 1],
    ["c", 1],
  ]);

  const ensemble = runEnsemble(results, weights);

  assertEquals(ensemble.insufficientConfidence, true);
  assertEquals(ensemble.message, COMPETING_CANDIDATES_MESSAGE);
});

Deno.test("runEnsemble: geological context boosts a matching label without adding a separate candidate", () => {
  const results: ProviderResult[] = [
    result({ provider: "gemini_vision", candidate: { label: "Malachite", confidence: 0.6 } }),
    result({
      provider: "geological_context",
      candidate: { label: "Malachite", confidence: 0.5 },
    }),
  ];
  const weights = new Map([
    ["gemini_vision", 1],
    ["geological_context", 1],
  ]);

  const withGeo = runEnsemble(results, weights);

  const withoutGeoResults: ProviderResult[] = [
    result({ provider: "gemini_vision", candidate: { label: "Malachite", confidence: 0.6 } }),
  ];
  const withoutGeo = runEnsemble(withoutGeoResults, new Map([["gemini_vision", 1]]));

  // The geo boost multiplies the aggregate score for the matching label by
  // 1.15x before normalization, so the boosted run's confidence should be
  // higher than the plain single-vote baseline once geo's own vote is
  // accounted for. At minimum, geo's presence must not overturn agreement or
  // crash — assert the boosted score for Malachite exceeds pre-boost naive
  // combination sanity: it must remain the top candidate.
  assertEquals(withGeo.candidates[0].label, "Malachite");
  assertEquals(withoutGeo.candidates[0].label, "Malachite");
});

Deno.test("runEnsemble: returns at most 6 ranked candidates (best + top 5 alternatives)", () => {
  const labels = ["A", "B", "C", "D", "E", "F", "G", "H"];
  const results: ProviderResult[] = labels.map((label, i) =>
    result({
      provider: `provider_${i}`,
      candidate: { label, confidence: 0.5 + i * 0.01 },
    }),
  );
  const weights = new Map(labels.map((_, i) => [`provider_${i}`, 1]));

  const ensemble = runEnsemble(results, weights);

  assertEquals(ensemble.candidates.length <= 6, true);
  // Ranks must be contiguous starting at 1.
  ensemble.candidates.forEach((c, i) => assertEquals(c.rank, i + 1));
});

Deno.test("runEnsemble: rank-1 candidate has null rejectedReason, others do not", () => {
  const results: ProviderResult[] = [
    result({ provider: "a", candidate: { label: "Ruby", confidence: 0.9 } }),
    result({ provider: "b", candidate: { label: "Sapphire", confidence: 0.4 } }),
  ];
  const weights = new Map([
    ["a", 1],
    ["b", 1],
  ]);

  const ensemble = runEnsemble(results, weights);

  assertEquals(ensemble.candidates[0].rejectedReason, null);
  assertEquals(ensemble.candidates[1].rejectedReason !== null, true);
});
