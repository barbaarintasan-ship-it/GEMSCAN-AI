// determineNextActions — Priority 3, the deterministic engine. Pins the exact
// five worked examples from the approved instruction, plus the two exclusive
// gates (deprioritize / insufficient evidence).
//
//   deno test shared/geo-core/gie/nextActionEngine.test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { determineNextActions, type NextActionInput } from "./nextActionEngine.ts";

function input(over: Partial<NextActionInput> = {}): NextActionInput {
  return {
    diagnosticFieldEvidenceCount: 0,
    hasAssay: false,
    assayGradeStrong: false,
    hasGeophysicsAnomaly: false,
    hasDetailedMapping: false,
    structuralAmbiguity: false,
    confirmedNegativeCount: 0,
    ...over,
  };
}

Deno.test("1. diagnostic field evidence + no assay -> recommend assay (strong signal)", () => {
  const out = determineNextActions(input({ diagnosticFieldEvidenceCount: 2 }));
  assertEquals(out[0].action, "recommend_lab_assay");
});

Deno.test("weak (single) diagnostic evidence + no assay -> collect a sample first", () => {
  const out = determineNextActions(input({ diagnosticFieldEvidenceCount: 1 }));
  assertEquals(out[0].action, "collect_sample");
});

Deno.test("2. structural ambiguity + no subsurface information -> consider geophysics", () => {
  const out = determineNextActions(input({
    diagnosticFieldEvidenceCount: 1, structuralAmbiguity: true,
  }));
  assertEquals(out.some((r) => r.action === "recommend_geophysics"), true);
});

Deno.test("structural ambiguity is silenced once geophysics already exists", () => {
  const out = determineNextActions(input({
    diagnosticFieldEvidenceCount: 1, structuralAmbiguity: true, hasGeophysicsAnomaly: true,
  }));
  assertEquals(out.some((r) => r.action === "recommend_geophysics"), false);
});

Deno.test("3. strong geological potential but poor mapping -> recommend detailed mapping", () => {
  const out = determineNextActions(input({
    diagnosticFieldEvidenceCount: 3, hasAssay: true, assayGradeStrong: false,
  }));
  assertEquals(out.some((r) => r.action === "recommend_detailed_mapping"), true);
});

Deno.test("4. multiple checked-negative indicators + weak positive -> deprioritize, exclusively", () => {
  const out = determineNextActions(input({
    diagnosticFieldEvidenceCount: 1, confirmedNegativeCount: 3,
  }));
  assertEquals(out.length, 1);
  assertEquals(out[0].action, "deprioritize_target");
});

Deno.test("strong positive evidence survives even heavy negative evidence — not deprioritized", () => {
  const out = determineNextActions(input({
    diagnosticFieldEvidenceCount: 3, confirmedNegativeCount: 5,
  }));
  assertEquals(out.some((r) => r.action === "deprioritize_target"), false);
});

Deno.test("5. strong verified assay -> the next appropriate step, never 'take another sample'", () => {
  const out = determineNextActions(input({
    diagnosticFieldEvidenceCount: 2, hasAssay: true, assayGradeStrong: true, hasDetailedMapping: false,
  }));
  assertEquals(out[0].action, "recommend_detailed_mapping");
  assertEquals(out.some((r) => r.action === "collect_sample"), false);
  assertEquals(out.some((r) => r.action === "recommend_lab_assay"), false);
});

Deno.test("strong verified assay WITH mapping already done -> geophysics, not mapping again", () => {
  const out = determineNextActions(input({
    diagnosticFieldEvidenceCount: 2, hasAssay: true, assayGradeStrong: true, hasDetailedMapping: true,
  }));
  assertEquals(out[0].action, "recommend_geophysics");
});

Deno.test("genuinely nothing to go on -> insufficient_evidence, exclusively", () => {
  const out = determineNextActions(input());
  assertEquals(out.length, 1);
  assertEquals(out[0].action, "insufficient_evidence");
});

Deno.test("a bare assay with no field evidence is enough to avoid 'insufficient evidence'", () => {
  const out = determineNextActions(input({ hasAssay: true }));
  assertEquals(out.some((r) => r.action === "insufficient_evidence"), false);
});

Deno.test("output is deterministic — same input, same output, every time", () => {
  const i = input({ diagnosticFieldEvidenceCount: 2, structuralAmbiguity: true });
  const a = determineNextActions(i);
  const b = determineNextActions(i);
  assertEquals(a, b);
});

Deno.test("output is capped at three actions and sorted by priority", () => {
  const out = determineNextActions(input({
    diagnosticFieldEvidenceCount: 3, structuralAmbiguity: true, hasDetailedMapping: false,
  }));
  assertEquals(out.length <= 3, true);
  for (let i = 1; i < out.length; i++) {
    assertEquals(out[i].priority >= out[i - 1].priority, true);
  }
});

Deno.test("no duplicate actions in the output", () => {
  const out = determineNextActions(input({
    diagnosticFieldEvidenceCount: 3, structuralAmbiguity: true,
  }));
  const actions = out.map((r) => r.action);
  assertEquals(new Set(actions).size, actions.length);
});

Deno.test("plain continue_field_investigation when there is positive evidence but no rule fires", () => {
  const out = determineNextActions(input({
    diagnosticFieldEvidenceCount: 1, hasAssay: true, hasDetailedMapping: true,
  }));
  assertEquals(out[0].action, "continue_field_investigation");
});

Deno.test("recommend_field_observation when there is truly nothing positive but SOMETHING exists (avoids the exclusive insufficient-evidence gate)", () => {
  const out = determineNextActions(input({ hasGeophysicsAnomaly: true }));
  assertEquals(out[0].action, "recommend_field_observation");
});
