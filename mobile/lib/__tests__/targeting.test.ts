// TargetingEngine (Stage E4) — workflow step 3, "where should I go, and why?"
import { buildPack } from "../../../shared/geo-core/pack/build.ts";
import type { PackData } from "../../../shared/geo-core/pack/types.ts";
import { bearingDeg, compassPoint } from "../../../shared/geo-core/geo/spatial.ts";
import { PackStore, createBundledPackSource } from "../geo/packStore.ts";
import { OfflineGeoContextService } from "../geo/offlineGeoContext.ts";
import { TargetingEngine } from "../geo/targeting.ts";

const MOG = { lat: 2.0469, lng: 45.3182 };
const NOW = Date.parse("2026-08-03T00:00:00.000Z");

const BUILD_OPTS = {
  packId: "somalia", packVersion: "1.0.0", engineVersion: "1.0.0", region: "SO",
  h3Resolution: 7, builtAt: "2026-08-01T00:00:00.000Z",
  datasets: [{ datasetId: "d1", source: "USGS MRDS", version: "2024" }],
};

function emptyData(): PackData {
  return {
    geology: [], occurrences: [], knowledge: [], structures: [], community: [], mapFeatures: [], terrain: [],
    associations: [], rules: [], commodities: [], assemblages: [], land: [],
  };
}

/** A cluster of gold occurrences ~4 km NE of the start point, and nothing elsewhere. */
function dataWithNeCluster(): PackData {
  const d = emptyData();
  d.geology = [{
    id: "g1", name: "Precambrian Basement", kind: "formation", source: "Macrostrat",
    attributes: null,
    rings: [[[45.0, 1.8], [45.8, 1.8], [45.8, 2.6], [45.0, 2.6], [45.0, 1.8]]],
    bbox: [45.0, 1.8, 45.8, 2.6], isPolygon: true,
  }];
  for (let i = 0; i < 4; i++) {
    d.occurrences.push({
      id: `o${i}`, name: `NE Gold ${i}`, commodity_key: "gold", deposit_type: "orogenic",
      host_rocks: ["greenstone"], lat: MOG.lat + 0.025 + i * 0.002, lng: MOG.lng + 0.025 + i * 0.002,
      dataset_id: "d1", source: "USGS MRDS", version: "2024", reference: `M${i}`, cell: "c",
    });
  }
  return d;
}

function engineFor(data: PackData | null) {
  const files = data ? buildPack(data, BUILD_OPTS).files : null;
  const store = new PackStore(createBundledPackSource(() => files), () => NOW);
  return new TargetingEngine(new OfflineGeoContextService(store));
}

// ── Bearing maths ───────────────────────────────────────────────────────────
describe("bearing", () => {
  test("cardinal directions", () => {
    expect(bearingDeg({ lat: 0, lng: 0 }, { lat: 1, lng: 0 })).toBeCloseTo(0, 5);   // N
    expect(bearingDeg({ lat: 0, lng: 0 }, { lat: 0, lng: 1 })).toBeCloseTo(90, 5);  // E
    expect(bearingDeg({ lat: 1, lng: 0 }, { lat: 0, lng: 0 })).toBeCloseTo(180, 5); // S
    expect(bearingDeg({ lat: 0, lng: 1 }, { lat: 0, lng: 0 })).toBeCloseTo(270, 5); // W
  });

  test("bearing is always 0..360", () => {
    const b = bearingDeg({ lat: 2, lng: 45 }, { lat: 1.5, lng: 44.5 });
    expect(b).toBeGreaterThanOrEqual(0);
    expect(b).toBeLessThan(360);
  });

  test("compass points round correctly, including the wrap at north", () => {
    expect(compassPoint(0)).toBe("N");
    expect(compassPoint(45)).toBe("NE");
    expect(compassPoint(180)).toBe("S");
    expect(compassPoint(350)).toBe("N");
    expect(compassPoint(359.9)).toBe("N");
  });
});

// ── Targeting ───────────────────────────────────────────────────────────────
describe("TargetingEngine", () => {
  test("ranks the neighbourhood and points toward the evidence", async () => {
    const result = await engineFor(dataWithNeCluster()).rank(MOG.lat, MOG.lng);

    expect(result.hasKnowledge).toBe(true);
    expect(result.targets.length).toBeGreaterThan(0);

    const best = result.targets[0];
    // The cluster is north-east, so the recommendation must send them that way.
    expect(best.bearingDeg).toBeGreaterThan(0);
    expect(best.bearingDeg).toBeLessThan(90);
    expect(["N", "NE", "E"]).toContain(best.compass);
    expect(best.commodities).toContain("gold");
  });

  test("every target carries its reasons — Invariant 2, no unexplained recommendation", async () => {
    const result = await engineFor(dataWithNeCluster()).rank(MOG.lat, MOG.lng);
    expect(result.targets.length).toBeGreaterThan(0);
    for (const t of result.targets) {
      expect(t.reasons.length).toBeGreaterThan(0);
      // Reasons are STRUCTURED, not prose: that is what lets the UI render them
      // in Somali as well as English. Anything pre-formatted here would be
      // untranslatable at the edge.
      for (const r of t.reasons) {
        expect(typeof r.kind).toBe("string");
        expect(r.kind.length).toBeGreaterThan(0);
      }
      // The mineralisation signal leads; mapped unit is context and comes last.
      expect(t.reasons[0].kind).not.toBe("unit");
    }
  });

  test("targets are ranked best first", async () => {
    const result = await engineFor(dataWithNeCluster()).rank(MOG.lat, MOG.lng);
    const scores = result.targets.map((t) => t.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  test("with no pack it offers nothing rather than inventing a direction", async () => {
    const result = await engineFor(null).rank(MOG.lat, MOG.lng);
    expect(result.hasKnowledge).toBe(false);
    expect(result.targets).toEqual([]);
    expect(result.bestIsHere).toBe(true);
  });

  test("a pack with no evidence anywhere yields no targets", async () => {
    const result = await engineFor(emptyData()).rank(MOG.lat, MOG.lng);
    expect(result.hasKnowledge).toBe(true);
    expect(result.targets).toEqual([]);
  });

  test("never recommends the cell the geologist is already standing in", async () => {
    const result = await engineFor(dataWithNeCluster()).rank(MOG.lat, MOG.lng);
    expect(result.targets.map((t) => t.cell)).not.toContain(result.current.cell);
  });

  test("respects the maximum leg distance", async () => {
    const result = await engineFor(dataWithNeCluster()).rank(MOG.lat, MOG.lng, { maxDistanceM: 3_000 });
    for (const t of result.targets) expect(t.distanceM).toBeLessThanOrEqual(3_000);
  });

  test("respects the result limit", async () => {
    const result = await engineFor(dataWithNeCluster()).rank(MOG.lat, MOG.lng, { limit: 1 });
    expect(result.targets.length).toBeLessThanOrEqual(1);
  });

  test("a higher minScore filters out weak targets", async () => {
    const engine = engineFor(dataWithNeCluster());
    const loose = await engine.rank(MOG.lat, MOG.lng, { minScore: 0.01 });
    const strict = await engine.rank(MOG.lat, MOG.lng, { minScore: 0.95 });
    expect(strict.targets.length).toBeLessThanOrEqual(loose.targets.length);
  });

  test("standing on the best ground is reported rather than being sent away", async () => {
    // Occurrences directly underfoot: the current cell should win.
    const d = emptyData();
    for (let i = 0; i < 4; i++) {
      d.occurrences.push({
        id: `o${i}`, name: `Here ${i}`, commodity_key: "gold", deposit_type: "orogenic",
        host_rocks: ["greenstone"], lat: MOG.lat + i * 0.0005, lng: MOG.lng + i * 0.0005,
        dataset_id: "d1", source: "USGS MRDS", version: "2024", reference: `M${i}`, cell: "c",
      });
    }
    const result = await engineFor(d).rank(MOG.lat, MOG.lng);
    expect(result.current.score).toBeGreaterThan(0);
    expect(result.bestIsHere).toBe(true);
  });

  test("the current cell's context is returned for the orient step", async () => {
    const result = await engineFor(dataWithNeCluster()).rank(MOG.lat, MOG.lng);
    expect(result.current.context.geology.unit).toBe("Precambrian Basement");
    expect(typeof result.current.cell).toBe("string");
  });

  test("ranking is deterministic — the same position gives the same answer", async () => {
    const engine = engineFor(dataWithNeCluster());
    const a = await engine.rank(MOG.lat, MOG.lng);
    const b = await engine.rank(MOG.lat, MOG.lng);
    expect(b.targets.map((t) => [t.cell, t.score, Math.round(t.distanceM)]))
      .toEqual(a.targets.map((t) => [t.cell, t.score, Math.round(t.distanceM)]));
  });

  test("a target names the commodity its evidence points at", async () => {
    const result = await engineFor(dataWithNeCluster()).rank(MOG.lat, MOG.lng);
    const occ = result.targets[0].reasons.find((r) => r.kind === "occurrence");
    expect(occ).toBeDefined();
    if (occ && occ.kind === "occurrence") {
      expect(occ.commodity).toBe("gold");
      expect(occ.distanceM).toBeGreaterThan(0);
    }
  });
});
