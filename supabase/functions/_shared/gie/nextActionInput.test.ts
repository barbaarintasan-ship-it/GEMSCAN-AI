// deriveNextActionInput — turning a flat ScoredEvidence[] into the counts
// nextActionEngine.ts's rules run on. Pins the group-naming convention this
// relies on (structuredEvidenceSource.ts's `evidence:{site}:{type}` prefix).
//
//   deno test supabase/functions/_shared/gie/nextActionInput.test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { deriveNextActionInput } from "./nextActionInput.ts";
import type { ScoredEvidence } from "../../../../shared/geo-core/gie/prospectivityReport.ts";

function item(over: Partial<ScoredEvidence> & { group: string }): ScoredEvidence {
  return { weight: 0.5, role: "field", tier: "user_reported", ...over };
}

Deno.test("empty input -> all zero/false", () => {
  const out = deriveNextActionInput([]);
  assertEquals(out.diagnosticFieldEvidenceCount, 0);
  assertEquals(out.hasAssay, false);
  assertEquals(out.confirmedNegativeCount, 0);
});

Deno.test("a structured-evidence quartz-vein group counts as diagnostic field evidence", () => {
  const out = deriveNextActionInput([item({ group: "evidence:c1:quartz_vein", role: "field" })]);
  assertEquals(out.diagnosticFieldEvidenceCount, 1);
});

Deno.test("a bare tapped-waypoint group (no 'evidence:' prefix) does NOT count as diagnostic — only structured evidence does", () => {
  const out = deriveNextActionInput([item({ group: "field:wp-1", role: "field" })]);
  assertEquals(out.diagnosticFieldEvidenceCount, 0);
});

Deno.test("an assay group is recognised as an assay, not double-counted as diagnostic field evidence", () => {
  const out = deriveNextActionInput([item({ group: "evidence:c1:assay:au", role: "geochemistry" })]);
  assertEquals(out.hasAssay, true);
  assertEquals(out.diagnosticFieldEvidenceCount, 0);
});

Deno.test("a strong-weight lab_verified assay is assayGradeStrong; a flat user_reported one is not", () => {
  const strong = deriveNextActionInput([
    item({ group: "evidence:c1:assay:au", role: "geochemistry", weight: 0.9, tier: "lab_verified" }),
  ]);
  const weak = deriveNextActionInput([
    item({ group: "evidence:c1:assay:au", role: "geochemistry", weight: 0.6, tier: "user_reported" }),
  ]);
  assertEquals(strong.assayGradeStrong, true);
  assertEquals(weak.assayGradeStrong, false);
});

Deno.test("a strong-weight assay WITHOUT a strong tier is not counted strong — both must hold", () => {
  const out = deriveNextActionInput([
    item({ group: "evidence:c1:assay:au", role: "geochemistry", weight: 0.9, tier: "user_reported" }),
  ]);
  assertEquals(out.assayGradeStrong, false);
});

Deno.test("a geophysics-role item is a geophysics anomaly", () => {
  const out = deriveNextActionInput([item({ group: "evidence:c1:geophysics:magnetics", role: "geophysics" })]);
  assertEquals(out.hasGeophysicsAnomaly, true);
});

Deno.test("lithology_reported and structural_mapping groups mean detailed mapping was done", () => {
  const out = deriveNextActionInput([
    item({ group: "evidence:c1:lithology_reported", role: "geology" }),
  ]);
  assertEquals(out.hasDetailedMapping, true);
});

Deno.test("a BASELINE structural item (no 'evidence:' prefix) with nothing else is structural ambiguity", () => {
  const out = deriveNextActionInput([item({ group: "structure:f1", role: "structural" })]);
  assertEquals(out.structuralAmbiguity, true);
});

Deno.test("structural ambiguity clears once geophysics OR detailed mapping exists", () => {
  const withGeophysics = deriveNextActionInput([
    item({ group: "structure:f1", role: "structural" }),
    item({ group: "evidence:c1:geophysics:magnetics", role: "geophysics" }),
  ]);
  assertEquals(withGeophysics.structuralAmbiguity, false);
});

Deno.test("negative-polarity groups are counted as confirmedNegativeCount, and never as positive/diagnostic", () => {
  const out = deriveNextActionInput([
    item({ group: "evidence:c1:confirmed_absent:alteration", role: "field", polarity: "negative" }),
  ]);
  assertEquals(out.confirmedNegativeCount, 1);
  assertEquals(out.diagnosticFieldEvidenceCount, 0);
});

Deno.test("duplicate groups (same site+type repeated) collapse — counted once", () => {
  const out = deriveNextActionInput([
    item({ group: "evidence:c1:quartz_vein", role: "field" }),
    item({ group: "evidence:c1:quartz_vein", role: "field", weight: 0.9 }),
  ]);
  assertEquals(out.diagnosticFieldEvidenceCount, 1);
});

Deno.test("two DIFFERENT diagnostic groups both count", () => {
  const out = deriveNextActionInput([
    item({ group: "evidence:c1:quartz_vein", role: "field" }),
    item({ group: "evidence:c1:sulfides", role: "field" }),
  ]);
  assertEquals(out.diagnosticFieldEvidenceCount, 2);
});
