// Map layers + terrain (Architecture §7.7) — structure and landform.
import { buildPack } from "../../../shared/geo-core/pack/build.ts";
import type { PackData, PackMapFeature, PackTerrainCell } from "../../../shared/geo-core/pack/types.ts";
import { PackStore, createBundledPackSource } from "../geo/packStore.ts";
import { OfflineGeoContextService } from "../geo/offlineGeoContext.ts";
import { TargetingEngine } from "../geo/targeting.ts";
import { featuresNear, intersectionsOf, terrainAt } from "../geo/terrainProviders.ts";

const MOG = { lat: 2.0469, lng: 45.3182 };
const NOW = Date.parse("2026-08-03T00:00:00.000Z");
const BUILD_OPTS = {
  packId: "somalia", packVersion: "1.0.0", engineVersion: "1.0.0", region: "SO",
  h3Resolution: 7, builtAt: "2026-08-01T00:00:00.000Z", datasets: [],
};

function emptyData(): PackData {
  return {
    geology: [], occurrences: [], knowledge: [], structures: [], community: [],
    mapFeatures: [], terrain: [],
    associations: [], rules: [], commodities: [], assemblages: [],
  };
}

/** A N–S fault ~110 m east of the start point. */
const fault: PackMapFeature = {
  id: "f1", kind: "fault", name: "Shabelle Fault", source: "Geological map", attributes: null,
  lines: [[[MOG.lng + 0.001, MOG.lat - 0.05], [MOG.lng + 0.001, MOG.lat + 0.05]]],
  bbox: [MOG.lng + 0.001, MOG.lat - 0.05, MOG.lng + 0.001, MOG.lat + 0.05],
};
/** An E–W contact ~110 m north of the start point. */
const contact: PackMapFeature = {
  id: "c1", kind: "contact", name: "Basement contact", source: "Geological map", attributes: null,
  lines: [[[MOG.lng - 0.05, MOG.lat + 0.001], [MOG.lng + 0.05, MOG.lat + 0.001]]],
  bbox: [MOG.lng - 0.05, MOG.lat + 0.001, MOG.lng + 0.05, MOG.lat + 0.001],
};
/** A lineament far away — inside the radius but weakly weighted. */
const lineament: PackMapFeature = {
  id: "l1", kind: "lineament", name: null, source: null, attributes: null,
  lines: [[[MOG.lng + 0.05, MOG.lat - 0.05], [MOG.lng + 0.05, MOG.lat + 0.05]]],
  bbox: [MOG.lng + 0.05, MOG.lat - 0.05, MOG.lng + 0.05, MOG.lat + 0.05],
};

const terrainCell = (over: Partial<PackTerrainCell> = {}): PackTerrainCell => ({
  cell: "t1", lat: MOG.lat, lng: MOG.lng, elevationM: 120, slopeDeg: 12,
  aspectDeg: 90, reliefM: 40, morphology: "ridge", drainageDistM: null, ...over,
});

function serviceFor(data: PackData, extra = false) {
  const files = buildPack(data, BUILD_OPTS).files;
  const packs = new PackStore(createBundledPackSource(() => files), () => NOW);
  return {
    geo: new OfflineGeoContextService(packs),
    targeting: new TargetingEngine(new OfflineGeoContextService(packs), undefined, () => packs.getData()),
    packs,
  };
}

// ── Distance to mapped lines ───────────────────────────────────────────────
describe("featuresNear", () => {
  test("measures to the LINE, not to an endpoint", () => {
    // The fault runs N–S through lng+0.001; the nearest point is due east.
    const near = featuresNear([fault], MOG.lat, MOG.lng, 10_000);
    expect(near).toHaveLength(1);
    expect(near[0].distanceM).toBeGreaterThan(100);
    expect(near[0].distanceM).toBeLessThan(120);
  });

  test("features outside the radius are excluded; nearest comes first", () => {
    const near = featuresNear([fault, contact, lineament], MOG.lat, MOG.lng, 10_000);
    expect(near.map((f) => f.id)).toEqual(["f1", "c1", "l1"].sort((a, b) => {
      const d = near.find((x) => x.id === a)!.distanceM - near.find((x) => x.id === b)!.distanceM;
      return d;
    }));
    expect(featuresNear([lineament], MOG.lat, MOG.lng, 100)).toEqual([]);
  });

  test("no features means no result, never a guess", () => {
    expect(featuresNear([], MOG.lat, MOG.lng, 10_000)).toEqual([]);
  });
});

// ── Structural intersections ───────────────────────────────────────────────
describe("intersections", () => {
  test("a fault and a contact both close by is reported as an intersection", () => {
    const near = featuresNear([fault, contact], MOG.lat, MOG.lng, 10_000);
    const x = intersectionsOf(near);
    expect(x).not.toBeNull();
    expect(x!.kinds.sort()).toEqual(["contact", "fault"]);
  });

  test("one structure alone is not an intersection", () => {
    expect(intersectionsOf(featuresNear([fault], MOG.lat, MOG.lng, 10_000))).toBeNull();
  });

  test("two structures that are both far away do not intersect here", () => {
    const farFault: PackMapFeature = { ...fault, lines: [[[MOG.lng + 0.05, MOG.lat - 0.05], [MOG.lng + 0.05, MOG.lat + 0.05]]], bbox: [MOG.lng + 0.05, MOG.lat - 0.05, MOG.lng + 0.05, MOG.lat + 0.05] };
    const farContact: PackMapFeature = { ...contact, lines: [[[MOG.lng - 0.05, MOG.lat + 0.05], [MOG.lng + 0.05, MOG.lat + 0.05]]], bbox: [MOG.lng - 0.05, MOG.lat + 0.05, MOG.lng + 0.05, MOG.lat + 0.05] };
    expect(intersectionsOf(featuresNear([farFault, farContact], MOG.lat, MOG.lng, 10_000))).toBeNull();
  });
});

// ── The providers in the GeoContext ────────────────────────────────────────
describe("map layer provider", () => {
  test("structures appear in the on-device context, named and measured", async () => {
    const d = emptyData();
    d.mapFeatures = [fault, contact];
    const { geo } = serviceFor(d);
    const { context } = await geo.contextAt(MOG.lat, MOG.lng);

    expect(context.meta.providersRun).toContain("map_layers");
    const factors = context.confidence.factors.join(" | ");
    expect(factors).toContain("Shabelle Fault");
    expect(factors).toMatch(/intersect within/);
  });

  test("with no map layers the provider contributes nothing and never fails", async () => {
    const { geo } = serviceFor(emptyData());
    const { context } = await geo.contextAt(MOG.lat, MOG.lng);
    expect(context.meta.providersFailed).toEqual([]);
    expect(context.confidence.score).toBe(0);
  });
});

describe("terrain provider", () => {
  test("is DORMANT with no DEM — contributes nothing rather than guessing a landform", async () => {
    const { geo } = serviceFor(emptyData());
    const { context } = await geo.contextAt(MOG.lat, MOG.lng);
    expect(context.meta.providersRun).toContain("terrain");
    expect(context.meta.providersFailed).toEqual([]);
    expect(context.confidence.factors.join(" ")).not.toMatch(/Ridge|Valley|Slope/);
  });

  test("with a DEM it explains how to read the ground", async () => {
    const d = emptyData();
    d.terrain = [terrainCell({ morphology: "ridge" })];
    const { geo } = serviceFor(d);
    const { context } = await geo.contextAt(MOG.lat, MOG.lng);
    expect(context.confidence.factors.join(" | ")).toContain("Ridge crest");
  });

  test("nearby drainage is called out as a panning opportunity", async () => {
    const d = emptyData();
    d.terrain = [terrainCell({ morphology: "valley", drainageDistM: 80 })];
    const { geo } = serviceFor(d);
    const { context } = await geo.contextAt(MOG.lat, MOG.lng);
    expect(context.confidence.factors.join(" | ")).toMatch(/panning/);
  });

  test("terrainAt picks the nearest cell", () => {
    const cells = [
      terrainCell({ cell: "far", lat: MOG.lat + 0.5, elevationM: 900 }),
      terrainCell({ cell: "near", elevationM: 120 }),
    ];
    expect(terrainAt(cells, MOG.lat, MOG.lng)!.cell).toBe("near");
    expect(terrainAt([], MOG.lat, MOG.lng)).toBeNull();
  });
});

// ── Structure drives targeting ─────────────────────────────────────────────
describe("structure changes where you are sent", () => {
  test("a fault-contact intersection makes ground a target where nothing else would", async () => {
    const withStructure = emptyData();
    // Structures ~2 km NE, inside the k-ring.
    const off = 0.018;
    withStructure.mapFeatures = [
      { ...fault, lines: [[[MOG.lng + off, MOG.lat + off - 0.05], [MOG.lng + off, MOG.lat + off + 0.05]]],
        bbox: [MOG.lng + off, MOG.lat + off - 0.05, MOG.lng + off, MOG.lat + off + 0.05] },
      { ...contact, lines: [[[MOG.lng + off - 0.05, MOG.lat + off], [MOG.lng + off + 0.05, MOG.lat + off]]],
        bbox: [MOG.lng + off - 0.05, MOG.lat + off, MOG.lng + off + 0.05, MOG.lat + off] },
    ];

    const bare = serviceFor(emptyData());
    const structured = serviceFor(withStructure);

    expect((await bare.targeting.rank(MOG.lat, MOG.lng)).targets).toEqual([]);
    const result = await structured.targeting.rank(MOG.lat, MOG.lng);
    expect(result.targets.length).toBeGreaterThan(0);
    // Reasons are structured so the UI can render them in Somali too.
    const kinds = result.targets[0].reasons.map((r) => r.kind);
    expect(kinds.some((k) => k === "fault" || k === "contact" || k === "intersection")).toBe(true);
  });

  test("drainage alone does not manufacture a lode target", async () => {
    const d = emptyData();
    d.mapFeatures = [{
      id: "d1", kind: "drainage", name: "Wadi", source: null, attributes: null,
      lines: [[[MOG.lng + 0.018, MOG.lat - 0.05], [MOG.lng + 0.018, MOG.lat + 0.05]]],
      bbox: [MOG.lng + 0.018, MOG.lat - 0.05, MOG.lng + 0.018, MOG.lat + 0.05],
    }];
    const { targeting } = serviceFor(d);
    // Drainage is context for float, not a structural target: it is not scored
    // into prospectivity, so it must not produce a recommendation on its own.
    expect((await targeting.rank(MOG.lat, MOG.lng)).targets).toEqual([]);
  });
});
