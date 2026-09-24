import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { structuredEvidenceRowToScored, teamIntegratedScore, type TeamStructuredEvidenceRow } from "./teamIntegratedEvidence.ts";
import type { Scored } from "../../../../shared/geo-core/gie/prospectivityEvidence.ts";

function row(over: Partial<TeamStructuredEvidenceRow>): TeamStructuredEvidenceRow {
  return {
    sampleId: "s1",
    evidenceType: "field_observation",
    payload: {},
    verificationStatus: "user_reported",
    ...over,
  };
}

Deno.test("assay: classifies grade and scales weight, tier passes through", () => {
  const scored = structuredEvidenceRowToScored(row({
    evidenceType: "assay",
    payload: { element: "Au", result: 12, unit: "g/t" },
    verificationStatus: "lab_verified",
  }));
  assertEquals(scored.length, 1);
  assertEquals(scored[0].tier, "lab_verified");
  assertEquals(scored[0].role, "geochemistry");
  assert(scored[0].weight > 0.6); // "high" band (5-15 g/t) scales 0.6 * 1.25
});

Deno.test("assay: missing element or non-numeric result produces nothing", () => {
  assertEquals(structuredEvidenceRowToScored(row({ evidenceType: "assay", payload: { element: "", result: 3 } })).length, 0);
  assertEquals(structuredEvidenceRowToScored(row({ evidenceType: "assay", payload: { element: "Au", result: "not a number" } })).length, 0);
});

Deno.test("geophysics: anomalyPresent=false produces nothing — existence isn't evidence", () => {
  const scored = structuredEvidenceRowToScored(row({
    evidenceType: "geophysics", payload: { surveyType: "magnetics", anomalyPresent: false },
  }));
  assertEquals(scored.length, 0);
});

Deno.test("geophysics: a real anomaly scores", () => {
  const scored = structuredEvidenceRowToScored(row({
    evidenceType: "geophysics", payload: { surveyType: "magnetics", anomalyPresent: true },
  }));
  assertEquals(scored.length, 1);
  assertEquals(scored[0].role, "geophysics");
});

Deno.test("mapping: gossan/sulfides/quartz vein each produce a field item, non-quartz vein type does not", () => {
  const scored = structuredEvidenceRowToScored(row({
    evidenceType: "mapping",
    payload: { hostLithology: "granite", veinType: "quartz-carbonate", gossan: true, sulfides: true },
  }));
  const groups = scored.map((s) => s.group);
  assertEquals(scored.filter((s) => s.role === "geology").length, 1); // lithology_reported
  assert(groups.some((g) => g.includes("gossan")));
  assert(groups.some((g) => g.includes("sulfides")));
  assert(groups.some((g) => g.includes("quartz_vein")));
});

Deno.test("mapping: no hostLithology and no indicators produces nothing", () => {
  const scored = structuredEvidenceRowToScored(row({ evidenceType: "mapping", payload: { hostLithology: "", veinType: "" } }));
  assertEquals(scored.length, 0);
});

Deno.test("remote_sensing: produces a remote_sensing-role item that teamIntegratedScore excludes", () => {
  const scored = structuredEvidenceRowToScored(row({
    evidenceType: "remote_sensing", payload: { source: "sentinel2", interpretation: "possible alteration halo" },
  }));
  assertEquals(scored.length, 1);
  assertEquals(scored[0].role, "remote_sensing");
});

Deno.test("field_observation: visibleMineral is suppressed when quartzVein or sulfides already fired (no double count)", () => {
  const scored = structuredEvidenceRowToScored(row({
    evidenceType: "field_observation", payload: { visibleMineral: true, quartzVein: true },
  }));
  assertEquals(scored.filter((s) => s.group.includes("visible_mineral_generic")).length, 0);
  assertEquals(scored.filter((s) => s.group.includes("quartz_vein")).length, 1);
});

Deno.test("field_observation: visibleMineral alone still scores", () => {
  const scored = structuredEvidenceRowToScored(row({
    evidenceType: "field_observation", payload: { visibleMineral: true },
  }));
  assertEquals(scored.filter((s) => s.group.includes("visible_mineral_generic")).length, 1);
});

Deno.test("field_observation: empty payload produces nothing", () => {
  assertEquals(structuredEvidenceRowToScored(row({ evidenceType: "field_observation", payload: {} })).length, 0);
});

// ── Phase 10.3 — negative/disconfirming evidence ────────────────────────────

Deno.test("field_observation: confirmedAbsent produces negative-polarity items, one per explicit true", () => {
  const scored = structuredEvidenceRowToScored(row({
    evidenceType: "field_observation",
    payload: { confirmedAbsent: { alteration: true, sulfides: true, quartzVein: false } },
  }));
  assertEquals(scored.length, 2); // quartzVein: false must NOT produce an item
  for (const s of scored) assertEquals(s.polarity, "negative");
  assert(scored.some((s) => s.group.includes("confirmed_absent:alteration")));
  assert(scored.some((s) => s.group.includes("confirmed_absent:sulfides")));
});

Deno.test("field_observation: confirmedAbsent with everything undefined/omitted produces nothing — tri-state by omission", () => {
  const scored = structuredEvidenceRowToScored(row({
    evidenceType: "field_observation",
    payload: { confirmedAbsent: {} },
  }));
  assertEquals(scored.length, 0);
});

Deno.test("field_observation: a positive finding and a confirmedAbsent finding on the same row both survive, uncancelled", () => {
  const scored = structuredEvidenceRowToScored(row({
    evidenceType: "field_observation",
    payload: { gossanRust: true, confirmedAbsent: { sulfides: true } },
  }));
  assertEquals(scored.filter((s) => s.polarity === "negative").length, 1);
  assertEquals(scored.filter((s) => s.polarity !== "negative").length, 1);
});

// ── teamIntegratedScore ─────────────────────────────────────────────────────

const BASELINE: Scored[] = [
  { item: { statement: "granite hosts occurrences", weight: 0.4, tier: "mapped" }, reason: { kind: "unit", name: "granite" }, role: "geology", group: "lithology" },
];

Deno.test("[architecture] teamIntegratedScore returns null with no evidence rows — baseline is never silently promoted", () => {
  assertEquals(teamIntegratedScore(BASELINE, []), null);
});

Deno.test("[architecture] teamIntegratedScore returns null when every row is remote_sensing (pending admission)", () => {
  const rows: TeamStructuredEvidenceRow[] = [
    row({ evidenceType: "remote_sensing", payload: { source: "s2", interpretation: "x" } }),
  ];
  assertEquals(teamIntegratedScore(BASELINE, rows), null);
});

Deno.test("teamIntegratedScore combines baseline + evidence and is at least the baseline-only combine", () => {
  const rows: TeamStructuredEvidenceRow[] = [
    row({ evidenceType: "field_observation", payload: { gossanRust: true }, verificationStatus: "expert_verified" }),
  ];
  const combined = teamIntegratedScore(BASELINE, rows);
  assert(combined !== null);
  assert(combined! > 0.4); // strictly more evidence than the baseline alone
  assert(combined! <= 1);
});

Deno.test("teamIntegratedScore with empty baseline still scores off evidence alone", () => {
  const rows: TeamStructuredEvidenceRow[] = [
    row({ evidenceType: "assay", payload: { element: "Au", result: 3, unit: "g/t" }, verificationStatus: "lab_verified" }),
  ];
  const combined = teamIntegratedScore([], rows);
  assert(combined !== null && combined! > 0);
});

Deno.test("[Phase 10.3] confirmed-absent evidence dampens the score, never zeroes it out", () => {
  const positiveOnly = teamIntegratedScore(BASELINE, [
    row({ evidenceType: "field_observation", payload: { gossanRust: true, sulfides: true } }),
  ]);
  const withNegative = teamIntegratedScore(BASELINE, [
    row({
      evidenceType: "field_observation",
      payload: { gossanRust: true, sulfides: true, confirmedAbsent: { quartzVein: true, alteration: true } },
    }),
  ]);
  assert(positiveOnly !== null && withNegative !== null);
  assert(withNegative! < positiveOnly!); // disconfirming evidence pulls the score down...
  assert(withNegative! > 0); // ...but never to zero — a mapped fault/occurrence doesn't stop being real
});

Deno.test("[Phase 10.3] confirmed-absent alone (no positive finding) still produces a real, non-null score", () => {
  const rows: TeamStructuredEvidenceRow[] = [
    row({ evidenceType: "field_observation", payload: { confirmedAbsent: { sulfides: true } } }),
  ];
  const combined = teamIntegratedScore(BASELINE, rows);
  assert(combined !== null);
  assert(combined! < 0.4); // damping the baseline-only combine, not ignored
});
