// Landform as evidence — and the two measurements that had to come first.
//
// Terrain was excluded from scoring outright, and the reason was not caution: the
// pack's DEM had been sampled in a k-ring around each known occurrence, so 100%
// of its 2,191 cells lay within 6.1 km of one. Coverage ratio 150 against
// background. Scoring it would have raised every validation number while teaching
// the model nothing but "somebody sampled the DEM here".
//
// Copernicus GLO-30 over the whole country replaced that with 254,623 cells at
// ratio 1.37, and the admission gate then measured whether it actually helps:
//
//     BLIND  with terrain  AUC 0.853  lift 2.526
//            without       AUC 0.810  lift 2.301
//
// Both conditions met, so it was admitted. These tests hold the arithmetic to
// the same restraint the lithology prior is held to, and pin the caveat that
// makes landform weaker than rock class.
import { buildTerrainPrior, MAX_TERRAIN_WEIGHT, terrainPriorFor } from "../geo/terrainPrior";
import { MAX_LITHOLOGY_WEIGHT } from "../geo/lithologyPrior";
import type { PackData, PackOccurrence, PackTerrainCell } from "../../../shared/geo-core/pack/types";
import { latLngToCell } from "h3-js";

const H3_RES = 7;

function cellAt(lat: number, lng: number, morphology: PackTerrainCell["morphology"]): PackTerrainCell {
  return {
    cell: latLngToCell(lat, lng, H3_RES),
    lat, lng, elevationM: 500, slopeDeg: 5, aspectDeg: 180,
    reliefM: 60, morphology, drainageDistM: null,
  };
}

function occurrence(lat: number, lng: number, i: number): PackOccurrence {
  return {
    id: `o${i}`, name: null, commodity_key: "gold", deposit_type: null, host_rocks: null,
    lat, lng, dataset_id: "d", source: "MRDS", version: null, reference: null, cell: "c",
  };
}

function pack(terrain: PackTerrainCell[], occurrences: PackOccurrence[]): PackData {
  return {
    geology: [], occurrences, knowledge: [], structures: [], community: [],
    mapFeatures: [], terrain, associations: [], rules: [], commodities: [],
    assemblages: [], land: [],
  };
}

/**
 * `n` DISTINCT cells of one landform.
 *
 * Spacing matters: an H3 resolution-7 cell is about 2.4 km across, so points
 * 0.03 degrees apart share cells and the terrain index — correctly — keeps one.
 * Stepping until the count is reached makes the fixture say what it means.
 */
function run(n: number, lat0: number, morphology: PackTerrainCell["morphology"], lng = 49.0) {
  const seen = new Set<string>();
  const out: PackTerrainCell[] = [];
  for (let i = 0; out.length < n && i < n * 20; i++) {
    const c = cellAt(lat0 + i * 0.05, lng, morphology);
    if (seen.has(c.cell)) continue;
    seen.add(c.cell);
    out.push(c);
  }
  return out;
}

describe("landform is measured, not assumed", () => {
  test("a class holding the occurrences in few cells is enriched", () => {
    // 20 valley cells carry every occurrence; 200 flat cells carry none.
    // Different longitudes, not just different latitudes: a 200-cell run steps
    // ten degrees north and would otherwise overwrite the valley cells.
    const valleys = run(20, 9.0, "valley", 49.0);
    const flats = run(200, 5.0, "flat", 45.0);
    const occ = valleys.map((c, i) => occurrence(c.lat, c.lng, i));

    const prior = buildTerrainPrior(pack([...valleys, ...flats], occ));
    expect(prior.statFor("valley")!.observed).toBe(20);
    expect(prior.weightFor("valley")).toBeGreaterThan(0);
    expect(prior.weightFor("flat")).toBe(0);
  });

  test("exposure is counted in CELLS, because every H3 cell is the same size", () => {
    // Counting cells rather than computing area avoids a second area measure that
    // could disagree with the first.
    const prior = buildTerrainPrior(pack(
      [...run(10, 9.0, "ridge", 49.0), ...run(30, 5.0, "flat", 45.0)],
      run(10, 9.0, "ridge", 49.0).map((c, i) => occurrence(c.lat, c.lng, i)),
    ));
    expect(prior.statFor("ridge")!.exposure).toBe(10);
    expect(prior.statFor("flat")!.exposure).toBe(30);
  });

  test("an occurrence with no DEM under it informs no class", () => {
    // Rather than being assigned to the nearest landform hundreds of kilometres
    // away, which would be a landform reading for ground never measured.
    const cells = run(10, 9.0, "valley");
    const prior = buildTerrainPrior(pack(cells, [occurrence(2.0, 45.0, 99)]));
    expect(prior.totalObserved).toBe(0);
  });
});

describe("what it refuses", () => {
  test("average landform earns nothing", () => {
    const a = run(20, 9.0, "valley", 49.0), b = run(20, 5.0, "ridge", 45.0);
    const occ = [
      ...a.slice(0, 10).map((c, i) => occurrence(c.lat, c.lng, i)),
      ...b.slice(0, 10).map((c, i) => occurrence(c.lat, c.lng, 100 + i)),
    ];
    const prior = buildTerrainPrior(pack([...a, ...b], occ));
    expect(prior.weightFor("valley")).toBe(0);
    expect(prior.weightFor("ridge")).toBe(0);
  });

  test("a landform with no DEM at all yields nothing rather than throwing", () => {
    const prior = buildTerrainPrior(pack([], []));
    expect(prior.stats).toEqual([]);
    expect(prior.weightFor("valley")).toBe(0);
  });

  test("an unknown landform contributes nothing rather than a default", () => {
    const prior = buildTerrainPrior(pack(run(10, 9.0, "valley"), []));
    expect(prior.weightFor("plateau")).toBe(0);
    expect(prior.weightFor(null)).toBe(0);
  });
});

describe("landform is weaker than rock class, deliberately", () => {
  test("its cap sits below lithology's", () => {
    // Part of what landform predicts is EXPOSURE — whether bedrock can be seen —
    // rather than whether it is mineralised. Valleys and steep ground reveal rock;
    // flat plains bury it. MRDS records where geologists could look, so some of
    // the valley signal is discovery bias. Useful either way, and weaker.
    expect(MAX_TERRAIN_WEIGHT).toBeLessThan(MAX_LITHOLOGY_WEIGHT);
  });

  test("no landform can approach what an observation is worth", () => {
    const valleys = run(5, 9.0, "valley", 49.0);
    const flats = run(500, 5.0, "flat", 45.0);
    const prior = buildTerrainPrior(pack(
      [...valleys, ...flats],
      valleys.map((c, i) => occurrence(c.lat, c.lng, i)),
    ));
    // Sulfides in hand are 0.85. This must stay far below.
    expect(prior.weightFor("valley")).toBeLessThanOrEqual(MAX_TERRAIN_WEIGHT);
  });
});

describe("caching", () => {
  test("the same pack is fitted once", () => {
    const p = pack(run(5, 9.0, "valley"), []);
    expect(terrainPriorFor(p)).toBe(terrainPriorFor(p));
  });
});

describe("the shipped pack, measured", () => {
  // A record of what the independent DEM says, so that a future ingest which
  // changes the picture cannot pass unnoticed.
  test("valleys carry the occurrences, and flat cover does not", () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require("fs") as typeof import("fs");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require("path") as typeof import("path");
    const dir = path.join(__dirname, "..", "..", "assets", "geo-pack");
    const read = (f: string) => {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as Record<string, unknown>;
      return (j.rows ?? Object.values(j).find(Array.isArray)) as unknown[];
    };
    const p = pack(read("terrain.json") as PackTerrainCell[], read("occurrences.json") as PackOccurrence[]);
    const prior = buildTerrainPrior(p);

    // Country-wide coverage: 36,505 cells at H3 resolution 6, not a halo of 2,191
    // at resolution 7. The coarser grid is a memory decision, measured: resolution
    // 7 took the app from 297 MB at rest to 588 MB, and 6 costs 0.010 of AUC.
    expect(prior.totalExposure).toBeGreaterThan(20_000);
    expect(prior.totalObserved).toBeGreaterThan(150);

    expect(prior.statFor("valley")!.enrichment).toBeGreaterThan(2);
    expect(prior.weightFor("valley")).toBeGreaterThan(0.1);
    expect(prior.weightFor("flat")).toBe(0);
  });
});
