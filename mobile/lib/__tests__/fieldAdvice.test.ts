// Rolling field guidance.
//
// The tests that matter here are the negative ones: advice appears only where
// the pack supplied a measurement, every line names its basis, and a DEM cell
// too far away to describe this ground is not interpreted at all.
import {
  fieldAdvice, MAX_ADVICE, STEEP_SLOPE_DEG, TERRAIN_TRUST_M, WALKABLE_M,
  type AdviceInput,
} from "../geo/fieldAdvice";

const EMPTY: AdviceInput = {
  terrain: null, unit: null, fault: null, contact: null,
  occurrence: null, target: null, evidenceNearby: 0,
};

const kinds = (i: AdviceInput) => fieldAdvice(i).map((a) => a.kind);

describe("fieldAdvice", () => {
  test("nothing in, nothing out — silence beats a vague sentence", () => {
    expect(fieldAdvice(EMPTY)).toEqual([]);
  });

  test("the engine's target outranks everything else", () => {
    const out = fieldAdvice({
      ...EMPTY,
      target: { distanceM: 600, bearingDeg: 0 },
      fault: { distanceM: 200, bearingDeg: 90, name: null },
    });
    expect(out[0].kind).toBe("continue_to_target");
  });

  test("a fault within walking range is offered; one beyond it is not", () => {
    expect(kinds({ ...EMPTY, fault: { distanceM: WALKABLE_M - 1, bearingDeg: 45, name: "Nogal" } }))
      .toContain("inspect_fault");
    expect(kinds({ ...EMPTY, fault: { distanceM: WALKABLE_M + 5_000, bearingDeg: 45, name: "Nogal" } }))
      .not.toContain("inspect_fault");
  });

  test("steep ground is called from the DEM's own slope", () => {
    const out = fieldAdvice({
      ...EMPTY,
      terrain: { slopeDeg: STEEP_SLOPE_DEG + 3, morphology: "slope", drainageDistM: null, fromM: 100 },
    });
    expect(out.map((a) => a.kind)).toContain("steep_outcrop");
    expect(out.find((a) => a.kind === "steep_outcrop")!.params.slopeDeg).toBe(STEEP_SLOPE_DEG + 3);
  });

  test("a DEM cell too far away is NOT interpreted", () => {
    const far = fieldAdvice({
      ...EMPTY,
      terrain: {
        slopeDeg: 40, morphology: "ridge", drainageDistM: 50, fromM: TERRAIN_TRUST_M + 1,
      },
    });
    expect(far).toEqual([]);
  });

  test("drainage advice needs a mapped drainage distance, not an assumption", () => {
    expect(kinds({
      ...EMPTY,
      terrain: { slopeDeg: 3, morphology: "valley", drainageDistM: 120, fromM: 200 },
    })).toContain("drainage_trap");

    expect(kinds({
      ...EMPTY,
      terrain: { slopeDeg: 3, morphology: "valley", drainageDistM: null, fromM: 200 },
    })).not.toContain("drainage_trap");
  });

  test("a lithology with no association in the pack says nothing about commodities", () => {
    expect(kinds({
      ...EMPTY,
      unit: { name: "Unnamed", lithology: "metamorphic", associated: [] },
    })).not.toContain("host_association");

    expect(kinds({
      ...EMPTY,
      unit: { name: "Basement", lithology: "metamorphic", associated: [{ commodity: "gold", weight: 0.8 }] },
    })).toContain("host_association");
  });

  test("evidence is only asked for where there is a reason to stop", () => {
    expect(kinds({ ...EMPTY, evidenceNearby: 0 })).not.toContain("capture_evidence");
    expect(kinds({
      ...EMPTY,
      evidenceNearby: 0,
      fault: { distanceM: 100, bearingDeg: 10, name: null },
    })).toContain("capture_evidence");
    expect(kinds({
      ...EMPTY,
      evidenceNearby: 2,
      fault: { distanceM: 100, bearingDeg: 10, name: null },
    })).not.toContain("capture_evidence");
  });

  test("every line names the pack row it came from", () => {
    const out = fieldAdvice({
      ...EMPTY,
      target: { distanceM: 400, bearingDeg: 10 },
      fault: { distanceM: 300, bearingDeg: 20, name: null },
      contact: { distanceM: 250, bearingDeg: 30 },
      occurrence: { distanceM: 900, bearingDeg: 40, commodity: "gold" },
      terrain: { slopeDeg: 30, morphology: "ridge", drainageDistM: 100, fromM: 300 },
    });
    for (const a of out) expect(a.basis.key).toMatch(/^field\.advice\.basis\./);
  });

  test("the list is capped and sorted best first", () => {
    const out = fieldAdvice({
      target: { distanceM: 400, bearingDeg: 10 },
      fault: { distanceM: 100, bearingDeg: 20, name: null },
      contact: { distanceM: 150, bearingDeg: 30 },
      occurrence: { distanceM: 500, bearingDeg: 40, commodity: "gold" },
      terrain: { slopeDeg: 35, morphology: "ridge", drainageDistM: 90, fromM: 200 },
      unit: { name: "Basement", lithology: "metamorphic", associated: [{ commodity: "gold", weight: 0.8 }] },
      evidenceNearby: 0,
    });
    expect(out.length).toBeLessThanOrEqual(MAX_ADVICE);
    for (let i = 1; i < out.length; i++) {
      expect(out[i - 1].priority).toBeGreaterThanOrEqual(out[i].priority);
    }
  });

  test("ids are stable, so the list does not re-key on every fix", () => {
    const input: AdviceInput = { ...EMPTY, fault: { distanceM: 300, bearingDeg: 20, name: null } };
    expect(fieldAdvice(input).map((a) => a.id)).toEqual(fieldAdvice(input).map((a) => a.id));
  });
});
