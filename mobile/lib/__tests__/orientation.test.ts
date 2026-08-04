// What the pack knows about a point — near and far.
//
// These tests are written against the real field failure: a geologist standing
// near Bosaso, where the nearest mapped occurrence is ~94 km away and the
// nearest fault ~86 km. Everything the screen could have said was suppressed by
// a proximity threshold, so the app said nothing at all.
import {
  orientationAt, nearestFault, nearestOccurrence, elevationAt, fittingRadiusM,
  NEARBY_FAULT_M, NEARBY_OCCURRENCE_M,
} from "../geo/orientation";
import type { PackData } from "../../../shared/geo-core/pack/types.ts";

const HERE = { lat: 9.5, lng: 49.0 };

/** A pack whose only features are FAR away, as most of the real one is. */
function remotePack(): PackData {
  return {
    geology: [],
    occurrences: [{
      id: "o1", name: "Far Gold", commodity_key: "gold", deposit_type: null,
      host_rocks: null,
      // ~0.85 deg south ≈ 94 km, and due south so the compass point is testable.
      lat: HERE.lat - 0.85, lng: HERE.lng, dataset_id: "d",
      source: "USGS MRDS", version: null, reference: null, cell: "c",
    }],
    knowledge: [], structures: [], community: [],
    mapFeatures: [{
      id: "f1", kind: "fault", name: "Nogal", source: "macrostrat_lines", attributes: null,
      // Due east, ~0.8 deg ≈ 88 km at this latitude.
      lines: [[[HERE.lng + 0.8, HERE.lat - 0.2], [HERE.lng + 0.8, HERE.lat + 0.2]]],
      bbox: [HERE.lng + 0.8, HERE.lat - 0.2, HERE.lng + 0.8, HERE.lat + 0.2],
    }],
    terrain: [{
      cell: "t1", lat: HERE.lat - 0.8, lng: HERE.lng, elevationM: 506, slopeDeg: 5,
      aspectDeg: null, reliefM: 147, morphology: "ridge", drainageDistM: null,
    }],
    associations: [], rules: [], commodities: [], assemblages: [], land: [],
  };
}

/** The same features, but close enough to be evidence for the ground underfoot. */
function localPack(): PackData {
  const d = remotePack();
  d.occurrences[0] = { ...d.occurrences[0], lat: HERE.lat + 0.02, lng: HERE.lng };
  d.mapFeatures[0] = {
    ...d.mapFeatures[0],
    lines: [[[HERE.lng + 0.05, HERE.lat - 0.1], [HERE.lng + 0.05, HERE.lat + 0.1]]],
    bbox: [HERE.lng + 0.05, HERE.lat - 0.1, HERE.lng + 0.05, HERE.lat + 0.1],
  };
  d.terrain[0] = { ...d.terrain[0], lat: HERE.lat, lng: HERE.lng };
  return d;
}

describe("the nearest feature is reported at ANY distance", () => {
  const o = orientationAt(remotePack(), HERE);

  test("a 94 km occurrence is still named, with its commodity", () => {
    expect(o.occurrence).not.toBeNull();
    expect(o.occurrence!.commodity).toBe("gold");
    expect(o.occurrence!.distanceM).toBeGreaterThan(90_000);
  });

  test("and with a direction to look — due south reads as a southerly bearing", () => {
    expect(o.occurrence!.bearingDeg).toBeGreaterThan(179);
    expect(o.occurrence!.bearingDeg).toBeLessThan(181);
  });

  test("the fault is measured and pointed at too", () => {
    expect(o.fault!.distanceM).toBeGreaterThan(80_000);
    expect(o.fault!.bearingDeg).toBeGreaterThan(88);
    expect(o.fault!.bearingDeg).toBeLessThan(92);
  });

  test("nothingNearby is true — which is what lets the screen say so plainly", () => {
    expect(o.nothingNearby).toBe(true);
  });

  test("elevation is withheld: a DEM cell 90 km away does not describe this ground", () => {
    expect(o.elevationM).toBeNull();
    // But the distance is still reported, so the screen can explain the silence
    // rather than simply omitting the line.
    expect(o.elevationFromM).toBeGreaterThan(80_000);
  });
});

describe("when features ARE close", () => {
  const o = orientationAt(localPack(), HERE);

  test("nothingNearby flips off", () => {
    expect(o.nothingNearby).toBe(false);
    expect(o.fault!.distanceM).toBeLessThan(NEARBY_FAULT_M);
    expect(o.occurrence!.distanceM).toBeLessThan(NEARBY_OCCURRENCE_M);
  });

  test("elevation is reported from the cell underfoot", () => {
    expect(o.elevationM).toBe(506);
  });
});

describe("an empty pack yields nulls, never zeros", () => {
  const empty: PackData = {
    geology: [], occurrences: [], knowledge: [], structures: [], community: [],
    mapFeatures: [], terrain: [], associations: [], rules: [], commodities: [], assemblages: [], land: [],
  };
  const o = orientationAt(empty, HERE);

  test("no fault, no occurrence, no elevation", () => {
    expect(o.fault).toBeNull();
    expect(o.occurrence).toBeNull();
    expect(o.elevationM).toBeNull();
    expect(o.elevationFromM).toBeNull();
  });

  test("a distance of zero would read as 'right here', so null it is", () => {
    expect(nearestFault(empty, HERE)).toBeNull();
    expect(nearestOccurrence(empty, HERE)).toBeNull();
    expect(elevationAt(empty, HERE)).toBeNull();
  });

  test("nothing known is still nothing nearby", () => {
    expect(o.nothingNearby).toBe(true);
  });
});

describe("non-fault map features are not mistaken for faults", () => {
  test("a contact line is ignored by nearestFault", () => {
    const d = remotePack();
    d.mapFeatures = [{ ...d.mapFeatures[0], kind: "contact" }];
    expect(nearestFault(d, HERE)).toBeNull();
  });
});

describe("the map view is widened to contain something", () => {
  const DEFAULT = 12_000;

  test("features far outside the default view widen it", () => {
    const r = fittingRadiusM(orientationAt(remotePack(), HERE), DEFAULT);
    expect(r).toBeGreaterThan(DEFAULT);
    // Wide enough to actually include the nearer of the two, with margin.
    expect(r).toBeGreaterThan(85_000);
  });

  test("features already inside it leave the scale alone", () => {
    expect(fittingRadiusM(orientationAt(localPack(), HERE), DEFAULT)).toBe(DEFAULT);
  });

  test("an empty pack keeps the default rather than zooming to nothing", () => {
    const empty: PackData = {
      geology: [], occurrences: [], knowledge: [], structures: [], community: [],
      mapFeatures: [], terrain: [], associations: [], rules: [], commodities: [], assemblages: [], land: [],
    };
    expect(fittingRadiusM(orientationAt(empty, HERE), DEFAULT)).toBe(DEFAULT);
  });

  test("the widening is capped — past a point the viewer is not locatable", () => {
    const d = remotePack();
    d.occurrences[0] = { ...d.occurrences[0], lat: -40, lng: 120 };
    d.mapFeatures = [];
    const r = fittingRadiusM(orientationAt(d, HERE), DEFAULT, 400_000);
    expect(r).toBe(400_000);
  });
});
