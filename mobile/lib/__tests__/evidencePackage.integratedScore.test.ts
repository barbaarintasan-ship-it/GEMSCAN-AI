// The Integrated Prospectivity Score at package-build time — Stage 3 wiring.
//
// buildEvidencePackage() is pure and must stay that way: it never invents a
// number from nothing. These tests pin the three ways integratedProspectivityScore
// legitimately comes back null (no evidence, empty evidence, no baseline to
// combine against) against the one way it is computed — and that it matches
// computeClientIntegratedScore() exactly, since a second implementation here
// would be the "two answers to the same question" bug this file exists to rule
// out.
import { buildEvidencePackage, type BuildPackageInput } from "../exploration/evidencePackage";
import { computeClientIntegratedScore } from "../exploration/structuredEvidenceSource";
import { emptyStructuredEvidence, type StructuredGeologicalEvidence } from "../field/structuredEvidenceTypes";
import type { Mission } from "../exploration/mission";
import type { Scored } from "../geo/targeting";

const NOW = Date.parse("2026-08-20T09:00:00.000Z");
const MISSION_ID = "ms-int-1";

function mission(): Mission {
  return {
    id: MISSION_ID, state: "field_investigation", cell: "87abc",
    centre: { lat: 9.5, lng: 45.5 }, hotspot: null, commodity: "gold",
    score: 0.42, startedAt: NOW, arrivedAt: NOW, packageId: null,
  } as Mission;
}

function baseInput(over: Partial<BuildPackageInput> = {}): BuildPackageInput {
  return {
    mission: mission(), explorationSessionId: "ex-1", waypoints: [], track: [],
    targetReasons: [], geologyContext: null, terrainContext: null,
    structuralContext: [], coverage: null, at: NOW + 10_000,
    ...over,
  };
}

const BASELINE: Scored[] = [
  {
    item: { statement: "lithology", weight: 0.25, tier: "mapped" }, role: "geology",
    group: "geology:g1", reason: { kind: "unit", name: "Precambrian Basement" },
  },
];

function evidenceWithAssay(): StructuredGeologicalEvidence {
  const e = emptyStructuredEvidence(MISSION_ID, MISSION_ID, "gold", NOW);
  return {
    ...e,
    assays: [{
      id: "a1", element: "Au", result: 12, unit: "g/t", sampleType: "grab",
      sampleId: "s1", location: null, samplingDate: null,
      verificationStatus: "user_reported", labAccredited: false, labName: "", notes: "",
    }],
  };
}

describe("integratedProspectivityScore — the three legal nulls", () => {
  test("no structured evidence at all", () => {
    const pkg = buildEvidencePackage(baseInput({ baselineEvidence: BASELINE }));
    expect(pkg.integratedProspectivityScore).toBeNull();
    expect(pkg.structuredEvidence).toBeNull();
  });

  test("a structured-evidence record with every section empty", () => {
    const empty = emptyStructuredEvidence(MISSION_ID, MISSION_ID, "gold", NOW);
    const pkg = buildEvidencePackage(baseInput({ structuredEvidence: empty, baselineEvidence: BASELINE }));
    expect(pkg.integratedProspectivityScore).toBeNull();
    // The record itself still travels — "nothing entered" is not "nothing to show".
    expect(pkg.structuredEvidence).toEqual(empty);
  });

  test("real evidence but no baseline to combine it with", () => {
    const pkg = buildEvidencePackage(baseInput({ structuredEvidence: evidenceWithAssay(), baselineEvidence: null }));
    expect(pkg.integratedProspectivityScore).toBeNull();
  });
});

describe("integratedProspectivityScore — computed, and computed the ONE way", () => {
  test("matches computeClientIntegratedScore() exactly, not a second formula", () => {
    const evidence = evidenceWithAssay();
    const pkg = buildEvidencePackage(baseInput({ structuredEvidence: evidence, baselineEvidence: BASELINE }));
    const expected = computeClientIntegratedScore(BASELINE, evidence, NOW + 10_000);
    expect(pkg.integratedProspectivityScore).toBe(expected);
    expect(pkg.integratedProspectivityScore).toBeGreaterThan(0);
  });

  test("prospectivityScore/reportScore are untouched by any of this", () => {
    const pkg = buildEvidencePackage(baseInput({ structuredEvidence: evidenceWithAssay(), baselineEvidence: BASELINE }));
    expect(pkg.prospectivityScore).toBe(0.42);
    expect(pkg.reportScore).toBe(0.42);
  });
});
