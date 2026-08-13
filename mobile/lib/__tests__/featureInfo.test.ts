// Tapping the map must answer from the pack — and only from the pack.
//
// These tests are as much about what identify does NOT do: it never fills a
// missing age in, never assigns a confidence to a polygon, and never claims a
// hit on a record the finger did not actually land near.
import {
  identifyAt, pointInRings, unitAt, terrainAt, nearestLineOfKind,
  associatedCommodities, journeyTo,
} from "../geo/featureInfo";
import type { PackData } from "../../../shared/geo-core/pack/types.ts";

const HERE = { lat: 9.5, lng: 49.0 };

/** A square ring around a centre, `d` degrees to a side. */
function square(lat: number, lng: number, d: number): Array<[number, number]> {
  return [
    [lng - d, lat - d], [lng + d, lat - d], [lng + d, lat + d],
    [lng - d, lat + d], [lng - d, lat - d],
  ];
}

function pack(over: Partial<PackData> = {}): PackData {
  return {
    geology: [{
      id: "g1",
      name: "Neoproterozoic metamorphic",
      kind: "metamorphic",
      source: "Macrostrat",
      attributes: {
        color: "#FF9BCD", interval: "Neoproterozoic",
        age_top_ma: 541, age_bottom_ma: 1000, lith: "metamorphic",
        descrip: "Gneiss and schist.",
      },
      // A unit with a HOLE in it: the inner ring is not part of the unit.
      rings: [square(HERE.lat, HERE.lng, 0.2), square(HERE.lat, HERE.lng, 0.02)],
      bbox: [HERE.lng - 0.2, HERE.lat - 0.2, HERE.lng + 0.2, HERE.lat + 0.2],
      isPolygon: true,
    }],
    occurrences: [{
      id: "o1", name: "Alio Ghelle", commodity_key: "gold", deposit_type: "vein",
      host_rocks: ["schist"], lat: HERE.lat + 0.001, lng: HERE.lng,
      dataset_id: "d", source: "USGS MRDS", version: null, reference: "MRDS 10123", cell: "c",
    }],
    knowledge: [], structures: [], community: [],
    mapFeatures: [{
      id: "f1", kind: "fault", name: "Nogal fault", source: "macrostrat_lines",
      attributes: null,
      lines: [[[HERE.lng + 0.004, HERE.lat - 0.05], [HERE.lng + 0.004, HERE.lat + 0.05]]],
      bbox: [HERE.lng + 0.004, HERE.lat - 0.05, HERE.lng + 0.004, HERE.lat + 0.05],
    }, {
      id: "c1", kind: "contact", name: null, source: "derived", attributes: null,
      lines: [[[HERE.lng - 0.01, HERE.lat - 0.05], [HERE.lng - 0.01, HERE.lat + 0.05]]],
      bbox: [HERE.lng - 0.01, HERE.lat - 0.05, HERE.lng - 0.01, HERE.lat + 0.05],
    }],
    terrain: [{
      cell: "t1", lat: HERE.lat, lng: HERE.lng, elevationM: 640, slopeDeg: 28,
      aspectDeg: 180, reliefM: 90, morphology: "slope", drainageDistM: 210,
    }],
    associations: [
      { commodity_code: "gold", host_rock_code: "metamorphic", weight: 0.8 },
      { commodity_code: "iron", host_rock_code: "metamorphic", weight: 0.3 },
      { commodity_code: "gypsum", host_rock_code: "sedimentary", weight: 0.9 },
    ],
    rules: [], commodities: [], assemblages: [], land: [],
    ...over,
  };
}

describe("pointInRings", () => {
  test("a hole is not part of the unit", () => {
    const rings = [square(HERE.lat, HERE.lng, 0.2), square(HERE.lat, HERE.lng, 0.02)];
    expect(pointInRings(rings, { lat: HERE.lat + 0.03, lng: HERE.lng })).toBe(true);
    // Dead centre is inside the hole — and therefore NOT inside the unit.
    expect(pointInRings(rings, HERE)).toBe(false);
  });

  test("outside is outside", () => {
    expect(pointInRings([square(HERE.lat, HERE.lng, 0.2)], { lat: 2, lng: 45 })).toBe(false);
  });
});

describe("unitAt", () => {
  test("finds the unit a point falls in", () => {
    expect(unitAt(pack(), { lat: HERE.lat + 0.03, lng: HERE.lng })?.id).toBe("g1");
  });

  test("no unit is null, never a nearest guess", () => {
    expect(unitAt(pack(), { lat: -20, lng: 20 })).toBeNull();
  });
});

describe("identifyAt", () => {
  test("a tap on an occurrence reports the MRDS record, unembellished", () => {
    // Tapped a little to one side of the record, as a finger actually lands.
    const id = identifyAt(pack(), { lat: HERE.lat + 0.0012, lng: HERE.lng }, { tapRadiusM: 60 });
    const occ = id.features.find((f) => f.kind === "occurrence");
    expect(occ).toBeDefined();
    if (occ?.kind !== "occurrence") throw new Error("wrong kind");
    expect(occ.name).toBe("Alio Ghelle");
    expect(occ.commodity).toBe("gold");
    expect(occ.depositType).toBe("vein");
    expect(occ.source).toBe("USGS MRDS");
    expect(occ.reference).toBe("MRDS 10123");
    // The offset is reported so a near miss is never presented as a bullseye.
    expect(occ.offsetM).toBeGreaterThan(0);
  });

  test("a tap far from the occurrence does not claim it", () => {
    const id = identifyAt(pack(), { lat: HERE.lat + 0.03, lng: HERE.lng }, { tapRadiusM: 60 });
    expect(id.features.some((f) => f.kind === "occurrence")).toBe(false);
  });

  test("the unit carries Macrostrat's own age, lithology and source", () => {
    const id = identifyAt(pack(), { lat: HERE.lat + 0.03, lng: HERE.lng });
    const unit = id.features.find((f) => f.kind === "unit");
    if (unit?.kind !== "unit") throw new Error("no unit");
    expect(unit.interval).toBe("Neoproterozoic");
    expect(unit.ageTopMa).toBe(541);
    expect(unit.ageBottomMa).toBe(1000);
    expect(unit.lithology).toBe("metamorphic");
    expect(unit.source).toBe("Macrostrat");
  });

  test("a field the pack does not carry stays null rather than being invented", () => {
    const p = pack();
    p.geology[0] = { ...p.geology[0], attributes: { color: "#FF9BCD" } };
    const id = identifyAt(p, { lat: HERE.lat + 0.03, lng: HERE.lng });
    const unit = id.features.find((f) => f.kind === "unit");
    if (unit?.kind !== "unit") throw new Error("no unit");
    expect(unit.interval).toBeNull();
    expect(unit.ageTopMa).toBeNull();
    expect(unit.lithology).toBeNull();
    expect(unit.associated).toEqual([]);
  });

  test("a tap on a fault reports the mapped line and where to go on it", () => {
    const id = identifyAt(pack(), { lat: HERE.lat, lng: HERE.lng + 0.004 }, { tapRadiusM: 80 });
    const line = id.features.find((f) => f.kind === "line");
    if (line?.kind !== "line") throw new Error("no line");
    expect(line.lineKind).toBe("fault");
    expect(line.name).toBe("Nogal fault");
    expect(Number.isFinite(line.lat)).toBe(true);
  });

  test("the DEM cell is reported with the distance it came from", () => {
    const id = identifyAt(pack(), { lat: HERE.lat + 0.03, lng: HERE.lng });
    const t = id.features.find((f) => f.kind === "terrain");
    if (t?.kind !== "terrain") throw new Error("no terrain");
    expect(t.slopeDeg).toBe(28);
    expect(t.morphology).toBe("slope");
    expect(t.drainageDistM).toBe(210);
    expect(t.fromM).toBeGreaterThan(0);
  });

  test("an empty pack identifies nothing rather than something vague", () => {
    const empty: PackData = {
      geology: [], occurrences: [], knowledge: [], structures: [], community: [],
      mapFeatures: [], terrain: [], associations: [], rules: [], commodities: [],
      assemblages: [], land: [],
    };
    expect(identifyAt(empty, HERE).features).toEqual([]);
  });

  test("the most specific answer comes first", () => {
    const id = identifyAt(pack(), { lat: HERE.lat + 0.001, lng: HERE.lng }, { tapRadiusM: 200 });
    expect(id.features[0].kind).toBe("occurrence");
  });
});

describe("navigating to a mapped line", () => {
  /**
   * A fault with its vertices far apart — which is what the real pack holds.
   *
   * Standing beside the MIDDLE of a long segment, the nearest vertex is a long
   * way off along the trace. Navigating there sends the geologist down the fault
   * instead of across to it, and the sheet would name a bearing to match.
   */
  const longFault = (): PackData => {
    const p = pack();
    p.mapFeatures = [{
      id: "f-long", kind: "fault", name: "Long trace", source: "macrostrat_lines",
      attributes: null,
      // A straight north–south trace with vertices ~11 km apart.
      lines: [[[49.05, 9.4], [49.05, 9.6]]],
      bbox: [49.05, 9.4, 49.05, 9.6],
    }];
    return p;
  };

  test("it goes to the nearest POINT on the trace, not the nearest vertex", () => {
    const data = longFault();
    // Due west of the middle of the segment.
    const at = { lat: 9.5, lng: 49.0 };
    const id = identifyAt(data, at, { tapRadiusM: 8_000 });
    const line = id.features.find((f) => f.kind === "line");
    if (line?.kind !== "line") throw new Error("no line");

    // The nearest point is straight east at the same latitude…
    expect(line.lat).toBeCloseTo(9.5, 3);
    expect(line.lng).toBeCloseTo(49.05, 3);
    // …and NOT either endpoint, which is where the vertex search used to send it.
    expect(Math.abs(line.lat - 9.4)).toBeGreaterThan(0.05);
    expect(Math.abs(line.lat - 9.6)).toBeGreaterThan(0.05);
  });

  test("the reported distance is the perpendicular one, not the vertex distance", () => {
    const data = longFault();
    const id = identifyAt(data, { lat: 9.5, lng: 49.0 }, { tapRadiusM: 8_000 });
    const line = id.features.find((f) => f.kind === "line");
    if (line?.kind !== "line") throw new Error("no line");
    // 0.05° of longitude at this latitude is about 5.5 km; the nearest vertex is
    // over 12 km away, so the two answers are not interchangeable.
    expect(line.offsetM).toBeGreaterThan(5_000);
    expect(line.offsetM).toBeLessThan(6_000);
  });

  test("past the end of a segment it clamps to the endpoint rather than running off", () => {
    const data = longFault();
    // North of the northern end.
    const id = identifyAt(data, { lat: 9.7, lng: 49.05 }, { tapRadiusM: 30_000 });
    const line = id.features.find((f) => f.kind === "line");
    if (line?.kind !== "line") throw new Error("no line");
    expect(line.lat).toBeCloseTo(9.6, 3);
  });
});

describe("associatedCommodities", () => {
  test("reads the pack's own table, best weight first", () => {
    expect(associatedCommodities(pack(), "metamorphic")).toEqual([
      { commodity: "gold", weight: 0.8 },
      { commodity: "iron", weight: 0.3 },
    ]);
  });

  test("an unknown lithology associates nothing", () => {
    expect(associatedCommodities(pack(), "kimberlite")).toEqual([]);
    expect(associatedCommodities(pack(), null)).toEqual([]);
  });
});

describe("nearestLineOfKind", () => {
  test("finds the contact and ignores the fault", () => {
    const c = nearestLineOfKind(pack(), HERE, "contact");
    expect(c).not.toBeNull();
    expect(c!.distanceM).toBeGreaterThan(0);
  });

  test("a kind the pack has none of is null", () => {
    expect(nearestLineOfKind(pack(), HERE, "drainage")).toBeNull();
  });
});

describe("terrainAt", () => {
  test("a cell too far away describes other ground and is refused", () => {
    expect(terrainAt(pack(), { lat: HERE.lat + 1, lng: HERE.lng })).toBeNull();
  });
});

describe("journeyTo", () => {
  test("no position means no bearing — Invariant 4", () => {
    expect(journeyTo(null, HERE)).toBeNull();
  });

  test("a real position gives a measured distance and bearing", () => {
    const j = journeyTo({ lat: HERE.lat - 0.01, lng: HERE.lng }, HERE);
    expect(j!.distanceM).toBeGreaterThan(1000);
    expect(j!.bearingDeg).toBeCloseTo(0, 0);
  });
});
