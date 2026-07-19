// Unit tests for the Advanced Diamond Verification prompt builder + parser.
// Run with: deno test --allow-none supabase/functions/verify-high-value/prompt.test.ts
import { assertEquals, assertMatch } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildVerificationPrompt, parseVerificationResponse } from "./prompt.ts";
import type { VerificationPromptInput } from "./prompt.ts";

function baseInput(overrides: Partial<VerificationPromptInput> = {}): VerificationPromptInput {
  return {
    previousResult: {
      bestMatch: "Diamond",
      confidenceScore: 0.62,
      confidenceBand: "medium",
      reasoning: "Strong brilliance and octahedral habit.",
      alternatives: [{ label: "Moissanite", confidence: 0.3 }],
    },
    hallmark: null,
    answers: {
      scratchesGlass: "yes",
      scratchesSteel: "no",
      transparency: "transparent",
      fire: "very_strong",
    },
    imageLabels: ["macro", "side"],
    location: null,
    ...overrides,
  };
}

Deno.test("buildVerificationPrompt: includes the original result, questionnaire answers, and image labels", () => {
  const prompt = buildVerificationPrompt(baseInput());
  assertMatch(prompt, /Diamond/);
  assertMatch(prompt, /62% confidence/);
  assertMatch(prompt, /Moissanite \(30%\)/);
  assertMatch(prompt, /Scratches glass: yes/);
  assertMatch(prompt, /Fire \(dispersion\) under light: very_strong/);
  assertMatch(prompt, /macro, side/);
  assertMatch(prompt, /NEVER state that the gemstone is definitely genuine/);
});

Deno.test("buildVerificationPrompt: marks unanswered fields as not provided rather than omitting them", () => {
  const prompt = buildVerificationPrompt(baseInput({ answers: {} }));
  assertMatch(prompt, /Scratches glass: not provided/);
  assertMatch(prompt, /Weight: not provided/);
});

Deno.test("buildVerificationPrompt: notes when no verification photos were supplied", () => {
  const prompt = buildVerificationPrompt(baseInput({ imageLabels: [] }));
  assertMatch(prompt, /No additional verification photos were supplied/);
});

Deno.test("buildVerificationPrompt: is not diamond-exclusive and instructs the evidence score + next-tests fields", () => {
  const prompt = buildVerificationPrompt(baseInput());
  assertMatch(prompt, /ANY potentially high-value gemstone/);
  assertMatch(prompt, /ruby, sapphire, emerald/i);
  assertMatch(prompt, /evidenceScore/);
  assertMatch(prompt, /recommendedNextTests/);
  assertMatch(prompt, /Thermal Diamond Tester/);
  assertMatch(prompt, /NEVER state that the gemstone is definitely genuine/);
});

Deno.test("parseVerificationResponse: parses a well-formed response", () => {
  const verdict = parseVerificationResponse(
    JSON.stringify({
      finalIdentification: "Natural Diamond",
      confidence: 0.78,
      probability: "Likely (70-85%)",
      reasoning: "Hardness and fire both match; weight consistent.",
      supportingEvidence: ["Scratches glass but not steel", "Very strong fire"],
      conflictingEvidence: ["Slightly lower sparkle than expected"],
      mostLikelyAlternatives: [{ label: "Moissanite", note: "Similar fire but different fog behavior" }],
      recommendation: "likely_natural_diamond",
      estimatedMarketValue: "Potentially significant if confirmed natural",
      professionalTestingRecommended: true,
      professionalTestingNote: "Recommend XRF or thermal conductivity test.",
      evidenceScore: 91,
      recommendedNextTests: ["Thermal Diamond Tester", "GIA"],
    }),
  );

  assertEquals(verdict.finalIdentification, "Natural Diamond");
  assertEquals(verdict.confidence, 0.78);
  assertEquals(verdict.recommendation, "likely_natural_diamond");
  assertEquals(verdict.supportingEvidence.length, 2);
  assertEquals(verdict.conflictingEvidence.length, 1);
  assertEquals(verdict.mostLikelyAlternatives[0].label, "Moissanite");
  assertEquals(verdict.professionalTestingRecommended, true);
  assertEquals(verdict.evidenceScore, 91);
  assertEquals(verdict.recommendedNextTests, ["Thermal Diamond Tester", "GIA"]);
});

Deno.test("parseVerificationResponse: defaults every field defensively when the model omits them", () => {
  const verdict = parseVerificationResponse(JSON.stringify({}));

  assertEquals(verdict.finalIdentification, "Unknown");
  assertEquals(verdict.confidence, 0);
  assertEquals(verdict.probability, "");
  assertEquals(verdict.supportingEvidence, []);
  assertEquals(verdict.conflictingEvidence, []);
  assertEquals(verdict.mostLikelyAlternatives, []);
  assertEquals(verdict.recommendation, "cannot_determine");
  assertEquals(verdict.professionalTestingRecommended, false);
  assertEquals(verdict.evidenceScore, 0);
  assertEquals(verdict.recommendedNextTests, []);
});

Deno.test("parseVerificationResponse: falls back to cannot_determine for an unrecognized recommendation value", () => {
  const verdict = parseVerificationResponse(JSON.stringify({ recommendation: "definitely a diamond trust me" }));
  assertEquals(verdict.recommendation, "cannot_determine");
});

Deno.test("parseVerificationResponse: clamps out-of-range confidence and strips a markdown code fence", () => {
  const verdict = parseVerificationResponse('```json\n{"confidence": 4.2}\n```');
  assertEquals(verdict.confidence, 1);
});

Deno.test("parseVerificationResponse: clamps evidenceScore to 0-100 and rounds it", () => {
  assertEquals(parseVerificationResponse(JSON.stringify({ evidenceScore: 142 })).evidenceScore, 100);
  assertEquals(parseVerificationResponse(JSON.stringify({ evidenceScore: -8 })).evidenceScore, 0);
  assertEquals(parseVerificationResponse(JSON.stringify({ evidenceScore: 90.6 })).evidenceScore, 91);
});

Deno.test("parseVerificationResponse: drops empty/null entries from recommendedNextTests", () => {
  const verdict = parseVerificationResponse(
    JSON.stringify({ recommendedNextTests: ["Refractive Index Test", "", null, "GIA"] }),
  );
  assertEquals(verdict.recommendedNextTests, ["Refractive Index Test", "GIA"]);
});

Deno.test("parseVerificationResponse: drops malformed entries from mostLikelyAlternatives rather than throwing", () => {
  const verdict = parseVerificationResponse(
    JSON.stringify({ mostLikelyAlternatives: [{ label: "Quartz", note: "ok" }, { note: "no label" }, null, "oops"] }),
  );
  assertEquals(verdict.mostLikelyAlternatives, [{ label: "Quartz", note: "ok" }]);
});
