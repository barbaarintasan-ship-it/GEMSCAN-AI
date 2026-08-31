// What a score was built from — and the four ways it can be built from nothing.
//
// A prospectivity number carried no account of its own basis: 0.6 from a single
// fault rendered identically to 0.6 from six agreeing layers. Worse, the app had
// no way to distinguish "there is no fault near you" from "faults were never
// mapped" from "geochemistry does not exist as a data source anywhere". All three
// read as silence, and silence reads as absence of mineralisation.
//
// These tests hold those distinctions apart. They are not cosmetic: the whole
// difference between a geological assistant and a confident liar is whether it
// can say "nobody has looked" instead of "there is nothing here".
import { coverageAt, coverageFraction, packCoverage, rolesInState } from "../geo/evidenceCoverage";
import { EVIDENCE_ROLES, type EvidenceRole } from "../geo/evidenceRoles";
import type { PackData, PackMapFeature } from "../../../shared/geo-core/pack/types";

const HERE = { lat: 9.5, lng: 49.0 };

const square = (d: number): Array<[number, number]> => [
  [HERE.lng - d, HERE.lat - d], [HERE.lng + d, HERE.lat - d],
  [HERE.lng + d, HERE.lat + d], [HERE.lng - d, HERE.lat + d],
  [HERE.lng - d, HERE.lat - d],
];

/** A mapped line about 1 km west of HERE — inside the 10 km coverage radius. */
function line(kind: PackMapFeature["kind"], id: string): PackMapFeature {
  return {
    id, kind, name: null, source: "test", attributes: null,
    lines: [[[48.99, 9.45], [48.99, 9.55]]],
    bbox: [48.98, 9.44, 49.0, 9.56],
  };
}

/** The same, but 300 km away: loaded, and nowhere near this point. */
function distantLine(kind: PackMapFeature["kind"], id: string): PackMapFeature {
  return {
    id, kind, name: null, source: "test", attributes: null,
    lines: [[[45.0, 6.0], [45.0, 6.1]]],
    bbox: [44.99, 5.99, 45.01, 6.11],
  };
}

function pack(over: Partial<PackData> = {}): PackData {
  return {
    geology: [], occurrences: [], knowledge: [], structures: [], community: [],
    mapFeatures: [], terrain: [], associations: [], rules: [], commodities: [],
    assemblages: [], land: [],
    ...over,
  };
}

const geologyUnit = {
  id: "g1", name: "Neoproterozoic metamorphic", kind: "metamorphic", source: "Macrostrat",
  attributes: null, rings: [square(0.2)], bbox: [48.8, 9.3, 49.2, 9.7] as [number, number, number, number],
  isPolygon: true,
};

const terrainCell = {
  cell: "c1", lat: HERE.lat, lng: HERE.lng, elevationM: 640, slopeDeg: 12,
  aspectDeg: 180, reliefM: 90, morphology: "slope" as const, drainageDistM: null,
};

describe("the four states are genuinely different claims", () => {
  test("no_source — nobody has ever collected this kind of data", () => {
    const c = coverageAt(pack(), new Set(), HERE);
    // geochemistry/geophysics moved off this list once the structured User
    // Geological Evidence form gave them a real (user-reported) source — see
    // ROLES_WITHOUT_SOURCE. remote_sensing stays here pending the Stage 6
    // scoring admission gate.
    expect(rolesInState(c, "no_source").sort()).toEqual(["remote_sensing"]);
  });

  test("empty_layer — the pack carries the layer and it has zero rows", () => {
    // This is the shipped state for contacts, lineaments, drainage and
    // associations: the pipeline exists, nobody has loaded the data.
    const c = coverageAt(pack({ mapFeatures: [line("fault", "f1")] }), new Set(["structural"]), HERE);
    const empty = rolesInState(c, "empty_layer");
    expect(empty).toContain("contacts");
    expect(empty).toContain("lineaments");
    expect(empty).toContain("association");
    // `drainage` is empty in THIS fixture because the fixture has no drainage
    // lines. In the shipped pack it is present-but-not-scored — a different
    // state, for a different reason. See the shipped-pack test below.
    expect(empty).toContain("drainage");
    // Faults ARE loaded, so structural is not in this bucket.
    expect(empty).not.toContain("structural");
  });

  test("none_here — the layer is populated and none of it reaches this point", () => {
    // "There are mapped faults in this country, just none within 10 km of you."
    // Materially different from "faults were never mapped", and the app used to
    // render both as nothing at all.
    const c = coverageAt(pack({ mapFeatures: [distantLine("fault", "f1")] }), new Set(), HERE);
    expect(rolesInState(c, "none_here")).toContain("structural");
    expect(rolesInState(c, "empty_layer")).not.toContain("structural");
  });

  test("not_scored holds exactly what measurement put there", () => {
    // Both roles that lived here have left, and neither left by opinion.
    //
    //   geology  was excluded because scoring well-MAPPED ground rewards survey
    //            coverage. Scoring its rock CLASS does not: 75% of occurrences in
    //            11% of the area, leakage ratio 0.99.
    //   terrain  was excluded because the DEM had been sampled around known
    //            occurrences — ratio 150. Country-wide Copernicus brought it to
    //            1.37 and the admission gate then showed it improves the blind
    //            AUC from 0.810 to 0.853.
    //
    // The state itself stays, because the next withheld layer will need it.
    const c = coverageAt(
      pack({ geology: [geologyUnit], terrain: [terrainCell], mapFeatures: [line("drainage", "d1")] }),
      new Set(), HERE,
    );
    // Only drainage. Geology and terrain both left this state on measurements;
    // drainage entered it on one — its network is real and unbiased, and carries
    // no signal this dataset can show.
    expect(rolesInState(c, "not_scored")).toEqual(["drainage"]);
    expect(rolesInState(c, "present")).toContain("geology");
    expect(rolesInState(c, "present")).toContain("terrain");
  });

  test("a layer that answered 'nothing here' still counts as consulted", () => {
    // Mapped geology saying "Cenozoic cover, unprospective" has answered the
    // question. Reporting that as missing data would tell the geologist the app
    // knows less than it does — and `present` is about availability, not about
    // whether the score went up.
    const c = coverageAt(pack({ geology: [geologyUnit] }), new Set(), HERE);
    expect(rolesInState(c, "present")).toContain("geology");
  });

  test("present — it produced evidence here", () => {
    const c = coverageAt(pack({ mapFeatures: [line("fault", "f1")] }), new Set(["structural"]), HERE);
    expect(rolesInState(c, "present")).toEqual(["structural"]);
    expect(c.present).toBe(1);
  });
});

describe("a role in the pack but not at this point is not the same as a role missing", () => {
  test("geology loaded but the point is outside every unit reads none_here", () => {
    const faraway = { lat: 2.0, lng: 45.0 };
    const c = coverageAt(pack({ geology: [geologyUnit] }), new Set(), faraway);
    expect(rolesInState(c, "none_here")).toContain("geology");
    expect(rolesInState(c, "present")).not.toContain("geology");
  });

  test("with no location the engine does not guess whether data is underfoot", () => {
    // Called without a point, nothing about THIS place can be established, and
    // the honest fallback is the weaker claim rather than an invented one.
    const c = coverageAt(pack({ geology: [geologyUnit] }), new Set());
    expect(rolesInState(c, "not_scored")).toEqual([]);
    expect(rolesInState(c, "none_here")).toContain("geology");
  });
});

describe("the count a geologist reads", () => {
  test("it is out of every role the engine can consume, not out of what is loaded", () => {
    // Scoring 4/4 when nine layers do not exist would be the flattering lie this
    // whole mechanism exists to prevent.
    const c = coverageAt(pack({ mapFeatures: [line("fault", "f1")] }), new Set(["structural"]), HERE);
    expect(c.total).toBe(EVIDENCE_ROLES.length);
    expect(c.present).toBe(1);
    expect(coverageFraction(c)).toBeCloseTo(1 / EVIDENCE_ROLES.length, 5);
  });

  test("`unavailable` is about the DATA, not about the place", () => {
    const c = coverageAt(pack({ mapFeatures: [distantLine("fault", "f1")] }), new Set(), HERE);
    // Faults exist somewhere, so structural is not "unavailable" even though it
    // produced nothing here.
    expect(c.unavailable).not.toContain("structural");
    expect(c.unavailable).toContain("contacts");
    // geochemistry/geophysics are no longer "unavailable" data — the structured
    // evidence form gives them a real source, same as `field`. remote_sensing
    // still has none until the Stage 6 admission gate.
    expect(c.unavailable).not.toContain("geochemistry");
    expect(c.unavailable).toContain("remote_sensing");
  });

  test("every role is reported exactly once — nothing quietly dropped", () => {
    const c = coverageAt(pack(), new Set(), HERE);
    expect(c.roles.map((r) => r.role).sort()).toEqual([...EVIDENCE_ROLES].sort());
  });
});

describe("packCoverage answers for the whole pack, before any location", () => {
  test("mapFeatures is four independent roles sharing one table", () => {
    const p = packCoverage(pack({ mapFeatures: [line("fault", "f1"), line("drainage", "d1")] }));
    expect(p.get("structural")).toBe("present");
    expect(p.get("drainage")).toBe("present");
    expect(p.get("contacts")).toBe("empty_layer");
    expect(p.get("lineaments")).toBe("empty_layer");
  });

  test("field observations are never the pack's fault", () => {
    // The geologist makes these. An empty pack cannot be the reason they are
    // unavailable, so the role must not be reported as an empty layer.
    expect(packCoverage(pack()).get("field")).toBe("present");
  });
});

describe("the shipped pack, as it actually stands", () => {
  // A deliberately explicit statement of today's position, so that when a layer
  // is finally loaded this test fails and somebody has to update the record.
  test("four layers ship empty and three roles have no source at all", () => {
    const shipped = pack({
      geology: [geologyUnit],
      occurrences: [{
        id: "o1", name: null, commodity_key: "gold", deposit_type: null, host_rocks: null,
        lat: HERE.lat, lng: HERE.lng, dataset_id: "d", source: "MRDS", version: null,
        reference: null, cell: "c1",
      }],
      mapFeatures: [line("fault", "f1")],
      terrain: [terrainCell],
    });
    const c = coverageAt(shipped, new Set<EvidenceRole>(["structural", "occurrence"]), HERE);
    expect(rolesInState(c, "empty_layer").sort())
      .toEqual(["association", "community", "contacts", "drainage", "lineaments"]);
    // Only remote_sensing has genuinely no source today. geochemistry/geophysics
    // now have one (the structured evidence form), same as field — with nothing
    // reported at this point in this fixture, they read none_here, not no_source.
    expect(rolesInState(c, "no_source").sort()).toEqual(["remote_sensing"]);
    // "field" was already none_here here (nobody tapped a waypoint in this
    // fixture) — geochemistry/geophysics now join it for the same reason.
    expect(rolesInState(c, "none_here").sort()).toEqual(["field", "geochemistry", "geophysics"]);
    // geology, structural, occurrence and terrain all consulted here.
    expect(rolesInState(c, "not_scored")).toEqual([]);
    expect(c.present).toBe(4);
  });
});
