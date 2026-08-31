// Stage 3 — structured evidence -> Observations, and the client "so-far" score.
import {
  assaysToObservations, geophysicsToObservations, mappingToObservations,
  remoteSensingToObservations, fieldObservationsToObservations,
  structuredEvidenceToObservations, makeStructuredEvidenceSource,
  computeClientIntegratedScore, INTEGRATED_ROLES_PENDING_ADMISSION,
  confirmedAbsentToObservations,
} from "../exploration/structuredEvidenceSource";
import { emptyStructuredEvidence, isEmptyStructuredEvidence } from "../field/structuredEvidenceTypes";
import type {
  AssayEntry, GeophysicsEntry, MappingEntry, RemoteSensingEntry, FieldObservationEntry,
} from "../field/structuredEvidenceTypes";
import { computeIntegratedProspectivity } from "../../../shared/geo-core/gie/integratedProspectivity";
import type { ScoredEvidence } from "../../../shared/geo-core/gie/prospectivityReport";
import type { Scored } from "../geo/targeting";

const NOW = Date.parse("2026-08-25T00:00:00.000Z");

function assay(overrides: Partial<AssayEntry> = {}): AssayEntry {
  return {
    id: "a1", element: "Au", result: 3.2, unit: "g/t", sampleType: "rock",
    sampleId: "LW-1", location: null, samplingDate: null,
    verificationStatus: "user_reported", labAccredited: false, labName: "", notes: "",
    ...overrides,
  };
}

function geophysics(overrides: Partial<GeophysicsEntry> = {}): GeophysicsEntry {
  return {
    id: "g1", surveyType: "magnetics", anomalyPresent: true, anomalyDescription: "strong positive",
    magnitude: null, surveyArea: "", location: null, interpretation: "",
    verificationStatus: "user_reported", notes: "",
    ...overrides,
  };
}

function mapping(overrides: Partial<MappingEntry> = {}): MappingEntry {
  return {
    id: "m1", hostLithology: "", rockType: "", formationUnit: "", alteration: "",
    veinType: "", veinWidthM: null, veinOrientation: "", strikeDeg: null, dipDeg: null,
    fault: false, shearZone: false, fold: false, breccia: false, gossan: false, sulfides: false,
    visibleMineralization: "", mineralAssemblage: "", structuralRelationship: "",
    mappingConfidence: "user_reported", notes: "",
    ...overrides,
  };
}

function remoteSensing(overrides: Partial<RemoteSensingEntry> = {}): RemoteSensingEntry {
  return {
    id: "r1", source: "sentinel2", alterationAnomaly: "", spectralAnomaly: "",
    structuralAnomaly: "", lineamentInterpretation: "", imageDate: null, areaCovered: "",
    interpretation: "possible alteration halo", confidence: "user_reported", notes: "",
    ...overrides,
  };
}

function fieldObs(overrides: Partial<FieldObservationEntry> = {}): FieldObservationEntry {
  return {
    id: "f1", visibleMineral: false, quartzVein: false, gossanRust: false, sulfides: false,
    alteration: false, shearing: false, faultExposure: false, oldWorkings: false,
    activeArtisanalMining: false, pits: false, shafts: false, adits: false, tailings: false,
    historicalProduction: false, localMiningEvidence: false, otherObservations: "",
    expertInterpretation: "", confidence: "user_reported", notes: "",
    ...overrides,
  };
}

describe("emptyStructuredEvidence / isEmptyStructuredEvidence", () => {
  it("a fresh record is empty", () => {
    expect(isEmptyStructuredEvidence(emptyStructuredEvidence("m1", "m1", "gold", NOW))).toBe(true);
  });
});

describe("A. assaysToObservations", () => {
  it("no result yet -> no observation", () => {
    expect(assaysToObservations("s1", [assay({ result: null })], NOW)).toEqual([]);
  });

  it("a reported assay scores at user_reported unless accredited/expert", () => {
    const [o] = assaysToObservations("s1", [assay()], NOW);
    expect(o.role).toBe("geochemistry");
    expect(o.tier).toBe("user_reported");
    expect(o.group).toBe("evidence:s1:assay:au");
  });

  it("lab_verified WITHOUT labAccredited downgrades to expert_verified", () => {
    const [o] = assaysToObservations(
      "s1", [assay({ verificationStatus: "lab_verified", labAccredited: false })], NOW,
    );
    expect(o.tier).toBe("expert_verified");
  });

  it("lab_verified WITH labAccredited stays lab_verified", () => {
    const [o] = assaysToObservations(
      "s1", [assay({ verificationStatus: "lab_verified", labAccredited: true })], NOW,
    );
    expect(o.tier).toBe("lab_verified");
  });

  it("different elements at the same site are independent groups", () => {
    const obs = assaysToObservations("s1", [assay({ id: "a1" }), assay({ id: "a2", element: "Sn" })], NOW);
    expect(obs).toHaveLength(2);
    expect(obs[0].group).not.toBe(obs[1].group);
  });

  // ── Priority 2: grade-aware weighting ──────────────────────────────────
  it("a materially higher gold grade produces a materially stronger weight", () => {
    const [low] = assaysToObservations("s1", [assay({ result: 0.05, unit: "g/t" })], NOW);
    const [high] = assaysToObservations("s1", [assay({ result: 20, unit: "g/t" })], NOW);
    expect(high.weight).toBeGreaterThan(low.weight);
    expect(low.statement).toContain("(trace)");
    expect(high.statement).toContain("(exceptional)");
  });

  it("an unclassified element/unit keeps the flat weight — same as before this priority existed", () => {
    const [copper] = assaysToObservations("s1", [assay({ element: "Cu", result: 5, unit: "%" })], NOW);
    const [plainSn] = assaysToObservations("s1", [assay({ element: "Sn", result: 5, unit: "g/t" })], NOW); // wrong unit for Sn
    expect(copper.weight).toBe(0.6);
    expect(plainSn.weight).toBe(0.6);
    expect(copper.statement).not.toContain("(");
  });

  it("a negative grade is treated as unclassified, never as strong negative evidence", () => {
    const [o] = assaysToObservations("s1", [assay({ result: -3, unit: "g/t" })], NOW);
    expect(o.weight).toBe(0.6);
    expect(o.polarity).toBeUndefined(); // an assay is never negative-polarity evidence
  });

  it("a strong grade AND a strong verification tier compound — both matter independently", () => {
    const weakUnverified = assaysToObservations(
      "s1", [assay({ result: 0.05, unit: "g/t", verificationStatus: "user_reported" })], NOW,
    )[0];
    const strongLabVerified = assaysToObservations(
      "s1", [assay({ result: 20, unit: "g/t", verificationStatus: "lab_verified", labAccredited: true })], NOW,
    )[0];
    expect(strongLabVerified.weight).toBeGreaterThan(weakUnverified.weight);
    expect(strongLabVerified.tier).toBe("lab_verified");
    expect(weakUnverified.tier).toBe("user_reported");
  });

  it("different commodities read different bands for the same numeric magnitude", () => {
    // 0.3 g/t Au is trace/low territory; 0.3% Sn is solidly moderate — the same
    // number means something different per commodity, and the classifier must
    // not apply one commodity's bands to another's result.
    const [gold] = assaysToObservations("s1", [assay({ element: "Au", result: 0.3, unit: "g/t" })], NOW);
    const [tin] = assaysToObservations("s1", [assay({ element: "Sn", result: 0.3, unit: "%" })], NOW);
    expect(gold.statement).toContain("(low)");
    expect(tin.statement).toContain("(moderate)");
  });
});

describe("B. geophysicsToObservations — 'exists' is not 'positive'", () => {
  it("no anomaly present -> no observation, however the survey is described", () => {
    expect(geophysicsToObservations("s1", [geophysics({ anomalyPresent: false })], NOW)).toEqual([]);
  });

  it("an anomaly present scores at role geophysics", () => {
    const [o] = geophysicsToObservations("s1", [geophysics()], NOW);
    expect(o.role).toBe("geophysics");
    expect(o.tier).toBe("user_reported");
  });

  it("expert_verified survey scores at verified_geophysics tier, not user_reported", () => {
    const [o] = geophysicsToObservations("s1", [geophysics({ verificationStatus: "expert_verified" })], NOW);
    expect(o.tier).toBe("verified_geophysics");
  });

  it("a claimed lab_verified geophysics reading is not trusted as lab_verified (no lab concept here)", () => {
    const [o] = geophysicsToObservations("s1", [geophysics({ verificationStatus: "lab_verified" })], NOW);
    expect(o.tier).toBe("verified_geophysics");
  });
});

describe("C. mappingToObservations", () => {
  it("an empty mapping entry produces nothing", () => {
    expect(mappingToObservations("s1", [mapping()], NOW)).toEqual([]);
  });

  it("lithology fields produce a geology-role item, capped weight below the fitted prior's 0.3", () => {
    const obs = mappingToObservations("s1", [mapping({ hostLithology: "schist" })], NOW);
    const item = obs.find((o) => o.role === "geology");
    expect(item).toBeDefined();
    expect(item!.weight).toBeLessThan(0.3);
  });

  it("structural fields (fault/shear/fold/breccia/strike/dip) produce a structural-role item", () => {
    const obs = mappingToObservations("s1", [mapping({ fault: true })], NOW);
    expect(obs.some((o) => o.role === "structural")).toBe(true);
  });

  it("gossan/sulfides/quartz-vein indicators use the SAME canonical type as a waypoint tap", () => {
    const obs = mappingToObservations("s1", [mapping({ gossan: true })], NOW);
    const gossanItem = obs.find((o) => o.group === "evidence:s1:gossan");
    expect(gossanItem).toBeDefined();
  });

  it("a non-quartz vein type still contributes, at a lower default weight", () => {
    const obs = mappingToObservations("s1", [mapping({ veinType: "calcite" })], NOW);
    const veinItem = obs.find((o) => o.group === "evidence:s1:vein_other");
    expect(veinItem).toBeDefined();
  });
});

describe("D. remoteSensingToObservations — captured, never labelled structural/fault", () => {
  it("an empty entry produces nothing", () => {
    expect(remoteSensingToObservations("s1", [remoteSensing({ interpretation: "" })], NOW)).toEqual([]);
  });

  it("an interpretation produces a remote_sensing-role item, tier remote_sensing", () => {
    const [o] = remoteSensingToObservations("s1", [remoteSensing()], NOW);
    expect(o.role).toBe("remote_sensing");
    expect(o.tier).toBe("remote_sensing");
  });

  it("a structural-sounding remote-sensing interpretation is never grouped as a mapped fault", () => {
    const [o] = remoteSensingToObservations(
      "s1", [remoteSensing({ structuralAnomaly: "possible fault trace" })], NOW,
    );
    expect(o.group).not.toContain(":fault");
    expect(o.group).toContain("remote_sensing:");
  });
});

describe("E. fieldObservationsToObservations", () => {
  it("no flags set -> nothing", () => {
    expect(fieldObservationsToObservations("s1", [fieldObs()], NOW)).toEqual([]);
  });

  it("mining-evidence flags collapse into ONE historical_workings item, not one per flag", () => {
    const obs = fieldObservationsToObservations(
      "s1", [fieldObs({ oldWorkings: true, pits: true, tailings: true })], NOW,
    );
    const workings = obs.filter((o) => o.group === "evidence:s1:historical_workings");
    expect(workings).toHaveLength(1);
  });

  it("quartz vein in the field-observation form uses the SAME group as a mapping-form quartz vein at the same site", () => {
    const viaField = fieldObservationsToObservations("s1", [fieldObs({ quartzVein: true })], NOW);
    const viaMapping = mappingToObservations("s1", [mapping({ veinType: "quartz" })], NOW);
    const fieldGroup = viaField.find((o) => o.group?.includes("quartz_vein"))!.group;
    const mappingGroup = viaMapping.find((o) => o.group?.includes("quartz_vein"))!.group;
    expect(fieldGroup).toBe(mappingGroup);
  });
});

describe("computeClientIntegratedScore", () => {
  it("empty evidence yields the same score as the baseline alone", () => {
    const baseline: Scored[] = [
      {
        item: { statement: "lithology", weight: 0.25, tier: "mapped" },
        reason: { kind: "unit", name: "metamorphic" }, role: "geology", group: "lithology",
      },
    ];
    const empty = emptyStructuredEvidence("m1", "m1", null, NOW);
    const integrated = computeClientIntegratedScore(baseline, empty, NOW);
    const baselineOnly = computeIntegratedProspectivity(
      baseline.map((s): ScoredEvidence => ({ weight: s.item.weight, tier: s.item.tier, role: s.role, group: s.group })),
    );
    expect(integrated).toBe(baselineOnly);
  });

  it("a real assay raises the score above baseline alone", () => {
    const baseline: Scored[] = [
      {
        item: { statement: "lithology", weight: 0.25, tier: "mapped" },
        reason: { kind: "unit", name: "metamorphic" }, role: "geology", group: "lithology",
      },
    ];
    const withoutNew = computeIntegratedProspectivity(
      baseline.map((s): ScoredEvidence => ({ weight: s.item.weight, tier: s.item.tier, role: s.role, group: s.group })),
    );
    const evidence = emptyStructuredEvidence("m1", "m1", "gold", NOW);
    evidence.assays.push(assay());
    const withNew = computeClientIntegratedScore(baseline, evidence, NOW);
    expect(withNew).toBeGreaterThan(withoutNew);
  });

  it("remote-sensing-only evidence does NOT raise the client score (pending admission)", () => {
    const baseline: Scored[] = [];
    const evidence = emptyStructuredEvidence("m1", "m1", "gold", NOW);
    evidence.remoteSensing.push(remoteSensing());
    const score = computeClientIntegratedScore(baseline, evidence, NOW);
    expect(score).toBe(0);
  });

  it("remote_sensing is in the pending-admission list", () => {
    expect(INTEGRATED_ROLES_PENDING_ADMISSION).toContain("remote_sensing");
  });
});

describe("confirmedAbsentToObservations — the ONLY source of negative evidence", () => {
  it("undefined findings (never opened the tri-state section) produce nothing", () => {
    expect(confirmedAbsentToObservations("s1", undefined, "user_reported", NOW)).toEqual([]);
  });

  it("an empty object (opened but nothing checked) produces nothing", () => {
    expect(confirmedAbsentToObservations("s1", {}, "user_reported", NOW)).toEqual([]);
  });

  it("a field explicitly set to false produces nothing — false is not the same as true", () => {
    const obs = confirmedAbsentToObservations("s1", { alteration: false }, "user_reported", NOW);
    expect(obs).toEqual([]);
  });

  it("only an explicit true produces a negative-polarity observation", () => {
    const obs = confirmedAbsentToObservations("s1", { alteration: true }, "user_reported", NOW);
    expect(obs).toHaveLength(1);
    expect(obs[0].polarity).toBe("negative");
    expect(obs[0].group).toBe("evidence:s1:confirmed_absent:alteration");
    expect(obs[0].tier).toBe("user_reported");
  });

  it("multiple confirmed-absent findings each produce their own item, in their own group", () => {
    const obs = confirmedAbsentToObservations(
      "s1",
      { alteration: true, sulfides: true, quartzVein: true },
      "expert_field",
      NOW,
    );
    expect(obs).toHaveLength(3);
    expect(new Set(obs.map((o) => o.group)).size).toBe(3); // three distinct groups
    for (const o of obs) expect(o.polarity).toBe("negative");
  });

  it("never produces a POSITIVE item — every item this function returns is negative", () => {
    const obs = confirmedAbsentToObservations(
      "s1",
      { alteration: true, sulfides: true, quartzVein: true, visibleMineralization: true,
        favorableStructure: true, geochemicalAnomaly: true },
      "user_reported",
      NOW,
    );
    expect(obs.every((o) => o.polarity === "negative")).toBe(true);
  });
});

describe("fieldObservationsToObservations — confirmedAbsent wiring", () => {
  it("a positive checkbox and a confirmedAbsent flag together produce BOTH items, not a cancellation", () => {
    const obs = fieldObservationsToObservations(
      "s1",
      [fieldObs({ sulfides: true, confirmedAbsent: { alteration: true } })],
      NOW,
    );
    expect(obs.some((o) => o.polarity !== "negative")).toBe(true); // the positive sulfides tap
    expect(obs.some((o) => o.polarity === "negative")).toBe(true); // the confirmed-absent alteration
  });

  it("a record with ONLY confirmedAbsent content is not empty — it is real evidence", () => {
    const obs = fieldObservationsToObservations(
      "s1", [fieldObs({ confirmedAbsent: { geochemicalAnomaly: true } })], NOW,
    );
    expect(obs).toHaveLength(1);
    expect(obs[0].polarity).toBe("negative");
  });
});

describe("computeClientIntegratedScore — negative evidence reaches the client score", () => {
  const baseline: Scored[] = [
    {
      item: { statement: "quartz vein", weight: 0.7, tier: "expert_field" },
      reason: { kind: "observation", label: "quartz-vein", distanceM: 0 },
      role: "field", group: "evidence:s1:quartz_vein",
    },
    {
      item: { statement: "sulfides", weight: 0.85, tier: "expert_field" },
      reason: { kind: "observation", label: "sulfides", distanceM: 0 },
      role: "field", group: "evidence:s1:sulfides",
    },
  ];

  it("a confirmed-absent finding lowers the integrated score below the positive-only baseline", () => {
    const withoutNegative = computeClientIntegratedScore(baseline, emptyStructuredEvidence("m1", "s1", "gold", NOW), NOW);
    const evidence = emptyStructuredEvidence("m1", "s1", "gold", NOW);
    evidence.fieldObservations.push(fieldObs({ confirmedAbsent: { alteration: true, geochemicalAnomaly: true } }));
    const withNegative = computeClientIntegratedScore(baseline, evidence, NOW);
    expect(withNegative).toBeLessThan(withoutNegative);
    expect(withNegative).toBeGreaterThan(0); // strong existing evidence is damped, not erased
  });
});

describe("makeStructuredEvidenceSource", () => {
  it("produces a LocalEvidenceSource whose observationsNear() ignores lat/lng/radius args", () => {
    const evidence = emptyStructuredEvidence("m1", "m1", "gold", NOW);
    evidence.fieldObservations.push(fieldObs({ sulfides: true }));
    const src = makeStructuredEvidenceSource(evidence, () => NOW);
    const obs = src.observationsNear(0, 0, 1);
    expect(obs.length).toBeGreaterThan(0);
  });
});

describe("structuredEvidenceToObservations — full record", () => {
  it("combines all five sections", () => {
    const e = emptyStructuredEvidence("m1", "m1", "gold", NOW);
    e.assays.push(assay());
    e.geophysics.push(geophysics());
    e.mapping.push(mapping({ gossan: true }));
    e.remoteSensing.push(remoteSensing());
    e.fieldObservations.push(fieldObs({ sulfides: true }));
    const all = structuredEvidenceToObservations(e, NOW);
    const roles = new Set(all.map((o) => o.role));
    expect(roles).toEqual(new Set(["geochemistry", "geophysics", "field", "remote_sensing"]));
  });
});
