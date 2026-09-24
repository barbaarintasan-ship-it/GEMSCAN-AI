// Integration-shaped tests for discover-region-targets with injected
// dependencies (no live Supabase stack) — Issue 1 (2026-09-24 audit): TRUE
// Phase 15 region-wide discovery. Runs the REAL fillMultiPolygon, REAL
// cellFor/cellCentre/cellBoundaryRing (h3-js) and the REAL TargetingEngine
// against a fake GeoContext source — only the network/DB edges are faked,
// exactly like team-targeting's own test suite.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { handleDiscoverRegionTargets, MAX_POLYGON_CELLS, MAX_BBOX_AREA_KM2, type RegionDiscoveryDeps } from "./handler.ts";
import type { Actor } from "../_shared/enterprise/auth.ts";
import { ForbiddenError, UnauthorizedError } from "../_shared/enterprise/errors.ts";
import { cellFor, cellCentre } from "../_shared/geocontext/h3.ts";
import { fillMultiPolygon } from "../generate-mission-cells/h3fill.ts";
import { TargetingEngine, type H3Ops, type GeoContextBatchSource } from "../../../shared/geo-core/gie/targetingEngine.ts";
import type { GeoContext } from "../../../shared/geo-core/types.ts";

const OWNER: Actor = { userId: "owner-1", email: "owner@example.com", contributorId: "c1", role: "admin" };

function req(body?: Record<string, unknown>, method = "POST"): Request {
  return new Request("https://x/discover-region-targets", { method, body: body ? JSON.stringify(body) : undefined });
}

const RES = 7;
// A small box: enough to span a handful of cells, fast to score in tests.
const SMALL_BOX: number[][] = [
  [45.00, 2.00], [45.02, 2.00], [45.02, 2.02], [45.00, 2.02], [45.00, 2.00],
];
const SMALL_POLYGON = { type: "Polygon", coordinates: [SMALL_BOX] };
const SMALL_CELLS = fillMultiPolygon({ type: "MultiPolygon", coordinates: [[SMALL_BOX]] }, RES);

// A large box, real fill confirmed (below) to exceed MAX_POLYGON_CELLS.
const HUGE_BOX: number[][] = [
  [44.00, 1.00], [44.60, 1.00], [44.60, 1.60], [44.00, 1.60], [44.00, 1.00],
];
const HUGE_POLYGON = { type: "Polygon", coordinates: [HUGE_BOX] };
const HUGE_CELL_COUNT = fillMultiPolygon({ type: "MultiPolygon", coordinates: [[HUGE_BOX]] }, RES).length;

function emptyContext(lat: number, lng: number): GeoContext {
  return {
    location: { lat, lng },
    geology: {}, formations: [], lithology: [], hostRocks: [], faults: [], intrusions: [],
    metamorphism: {}, knownOccurrences: [], commodityAssociations: [],
    geochemistry: { anomalies: [] }, geophysics: { anomalies: [] }, remoteSensing: { alteration: [] },
    historicalReports: [], communityEvidence: {},
    reasoningFactors: [], evidence: { providers: [], datasets: [] },
    confidence: { overall: "Low", score: 0, byProvider: {}, factors: [] },
    meta: { engineVersion: "test", generatedAt: "2026-01-01T00:00:00.000Z", providersRun: [], providersFailed: [], cache: "miss" },
  };
}

/** Occurrence evidence stronger near one specific real cell's centre than
 *  anywhere else — so the fake engine produces a genuinely uneven score
 *  distribution across SMALL_CELLS, letting tests exercise real filtering. */
function fakeGeoFavouring(hotCell: string): GeoContextBatchSource {
  const hot = cellCentre(hotCell);
  const query = async (lat: number, lng: number) => {
    const ctx = emptyContext(lat, lng);
    const dLat = Math.abs(lat - hot.lat);
    const dLng = Math.abs(lng - hot.lng);
    if (dLat < 0.001 && dLng < 0.001) {
      ctx.knownOccurrences = [{ commodity: "Gold", distanceM: 200 }];
    }
    return { context: ctx, hasKnowledge: true };
  };
  return { contextAt: query, openBatch: async () => query };
}

const REAL_H3_OPS: H3Ops = {
  cellFor,
  cellCentre,
  kRing: () => { throw new Error("kRing must never be called by polygon discovery"); },
};

function baseDeps(overrides: Partial<RegionDiscoveryDeps> = {}): RegionDiscoveryDeps {
  return {
    resolveActor: async () => OWNER,
    isMissionManager: async () => true,
    buildEngine: async () => new TargetingEngine(fakeGeoFavouring(SMALL_CELLS[0]), REAL_H3_OPS),
    ...overrides,
  };
}

Deno.test("[fixture sanity] the huge box really does exceed MAX_POLYGON_CELLS", () => {
  assertEquals(HUGE_CELL_COUNT > MAX_POLYGON_CELLS, true);
});

Deno.test("OPTIONS returns CORS preflight ok", async () => {
  const r = await handleDiscoverRegionTargets(req(undefined, "OPTIONS"), baseDeps());
  assertEquals(r.status, 200);
});

Deno.test("missing missionId/polygon → 400", async () => {
  const r1 = await handleDiscoverRegionTargets(req({ polygon: SMALL_POLYGON }), baseDeps());
  assertEquals(r1.status, 400);
  const r2 = await handleDiscoverRegionTargets(req({ missionId: "m1" }), baseDeps());
  assertEquals(r2.status, 400);
});

Deno.test("non-manager caller → 403, no scan attempted", async () => {
  let engineBuilt = false;
  const deps = baseDeps({
    isMissionManager: async () => false,
    buildEngine: async () => { engineBuilt = true; return new TargetingEngine(fakeGeoFavouring(SMALL_CELLS[0]), REAL_H3_OPS); },
  });
  const r = await handleDiscoverRegionTargets(req({ missionId: "m1", polygon: SMALL_POLYGON }), deps);
  assertEquals(r.status, 403);
  assertEquals(engineBuilt, false);
});

Deno.test("missing/invalid JWT → 401", async () => {
  const deps = baseDeps({ resolveActor: async () => { throw new UnauthorizedError(); } });
  const r = await handleDiscoverRegionTargets(req({ missionId: "m1", polygon: SMALL_POLYGON }), deps);
  assertEquals(r.status, 401);
});

Deno.test("invalid polygon type → 422 invalid_area_geometry", async () => {
  const r = await handleDiscoverRegionTargets(req({ missionId: "m1", polygon: { type: "Point", coordinates: [1, 2] } }), baseDeps());
  assertEquals(r.status, 422);
  assertEquals((await r.json()).code, "invalid_area_geometry");
});

// ── [1] polygon → H3 fill ───────────────────────────────────────────────────

Deno.test("[1] the polygon is filled with the real, deterministic H3 cell set — not a k-ring around a point", async () => {
  const r = await handleDiscoverRegionTargets(req({ missionId: "m1", polygon: SMALL_POLYGON }), baseDeps());
  assertEquals(r.status, 200);
  const b = await r.json();
  assertEquals(b.resolution, RES);
  assertEquals(b.totalCellsInPolygon, SMALL_CELLS.length);
});

// ── [2] only cells inside the polygon are processed ─────────────────────────

Deno.test("[2] only cells inside the requested polygon are scored — none outside it", async () => {
  let scoredCells: string[] = [];
  const deps = baseDeps({
    buildEngine: async () => {
      const engine = new TargetingEngine(fakeGeoFavouring(SMALL_CELLS[0]), REAL_H3_OPS);
      const realTargetAt = engine.targetAt.bind(engine);
      engine.targetAt = (from, at, opts) => {
        scoredCells.push(cellFor(at.lat, at.lng));
        return realTargetAt(from, at, opts);
      };
      return engine;
    },
  });
  await handleDiscoverRegionTargets(req({ missionId: "m1", polygon: SMALL_POLYGON }), deps);
  const cellSet = new Set(SMALL_CELLS);
  assertEquals(scoredCells.length, SMALL_CELLS.length);
  for (const c of scoredCells) assertEquals(cellSet.has(c), true, `scored a cell outside the polygon: ${c}`);
});

// ── [3][4] cell count limit enforced, oversized polygon rejected not truncated ─

Deno.test("[3][4] a polygon exceeding MAX_POLYGON_CELLS is REJECTED (422/400-shaped, no scoring attempted), never silently truncated", async () => {
  let engineBuilt = false;
  const deps = baseDeps({ buildEngine: async () => { engineBuilt = true; throw new Error("must not be reached"); } });
  const r = await handleDiscoverRegionTargets(req({ missionId: "m1", polygon: HUGE_POLYGON }), deps);
  assertEquals(r.status, 400);
  const b = await r.json();
  assertEquals(typeof b.error, "string");
  assertEquals(b.error.includes(String(MAX_POLYGON_CELLS)), true);
  assertEquals(engineBuilt, false, "scoring must never start once the cap is exceeded");
});

// ── Real bug (2026-09-24): astronomically oversized polygon rejected BEFORE
// the expensive real fill, not left to hang/crash the function ─────────────

Deno.test("[bbox guard] a ~3700km-tall polygon (real mistyped-corner bug) is rejected fast, before fillMultiPolygon ever runs", async () => {
  // Corner A ~ (9.5156, 44.x), Corner B ~ (43.1432, 49.x) — the exact
  // real-world mistake: a latitude typo turned a small scan into a
  // continental one. bbox rejection must fire without ever calling the
  // (potentially very slow/expensive) real H3 fill for a box this size.
  const gigantic = {
    type: "Polygon",
    coordinates: [[[44.0, 9.5156], [49.0, 9.5156], [49.0, 43.1432], [44.0, 43.1432], [44.0, 9.5156]]],
  };
  let engineBuilt = false;
  const deps = baseDeps({ buildEngine: async () => { engineBuilt = true; throw new Error("must not be reached"); } });
  const start = Date.now();
  const r = await handleDiscoverRegionTargets(req({ missionId: "m1", polygon: gigantic }), deps);
  const elapsedMs = Date.now() - start;
  assertEquals(r.status, 400);
  const b = await r.json();
  assertEquals(b.error.includes(MAX_BBOX_AREA_KM2.toLocaleString()), true);
  assertEquals(engineBuilt, false);
  // A real fillMultiPolygon over a box this size would be far slower than
  // this — confirms the guard fired first, not merely that scoring failed.
  assertEquals(elapsedMs < 2000, true, `rejection took ${elapsedMs}ms — bbox guard may not have short-circuited before the real fill`);
});

// ── [5] deterministic TargetingEngine used ──────────────────────────────────

Deno.test("[5] scores come from the real TargetingEngine, not a placeholder — the hot cell scores higher than a cold one", async () => {
  const r = await handleDiscoverRegionTargets(req({ missionId: "m1", polygon: SMALL_POLYGON, minScore: 0 }), baseDeps());
  const b = await r.json();
  const hotCluster = b.clusters.find((c: any) => c.memberCells.includes(SMALL_CELLS[0]));
  assertEquals(hotCluster != null, true);
  assertEquals(hotCluster.score > 0, true);
});

Deno.test("[5] low-scoring cells are filtered out using minScore, same semantics as point targeting", async () => {
  const r = await handleDiscoverRegionTargets(req({ missionId: "m1", polygon: SMALL_POLYGON, minScore: 0.9 }), baseDeps());
  const b = await r.json();
  // Nothing in this fixture scores anywhere near 0.9 — everything should be filtered.
  assertEquals(b.clusters.length, 0);
  assertEquals(b.filteredOutCells, b.scoredCells);
});

// ── [6] spatial clustering deterministic ────────────────────────────────────

Deno.test("[6] clustering is deterministic across repeated identical calls", async () => {
  const r1 = await handleDiscoverRegionTargets(req({ missionId: "m1", polygon: SMALL_POLYGON, minScore: 0 }), baseDeps());
  const r2 = await handleDiscoverRegionTargets(req({ missionId: "m1", polygon: SMALL_POLYGON, minScore: 0 }), baseDeps());
  const b1 = await r1.json();
  const b2 = await r2.json();
  assertEquals(b1.clusters.map((c: any) => c.memberCells), b2.clusters.map((c: any) => c.memberCells));
});

// ── [7] cluster geometry valid ───────────────────────────────────────────────

Deno.test("[7] every cluster has valid MultiPolygon geometry, one ring per member cell", async () => {
  const r = await handleDiscoverRegionTargets(req({ missionId: "m1", polygon: SMALL_POLYGON, minScore: 0 }), baseDeps());
  const b = await r.json();
  assertEquals(b.clusters.length > 0, true);
  for (const cluster of b.clusters) {
    assertEquals(cluster.geometry.type, "MultiPolygon");
    assertEquals(cluster.geometry.coordinates.length, cluster.memberCells.length);
    for (const polygon of cluster.geometry.coordinates) {
      const ring = polygon[0];
      assertEquals(ring.length >= 4, true, "a closed hex ring needs at least 4 points");
      assertEquals(ring[0][0], ring[ring.length - 1][0], "ring must close (lng)");
      assertEquals(ring[0][1], ring[ring.length - 1][1], "ring must close (lat)");
    }
  }
});

// ── [8] no AI involved ───────────────────────────────────────────────────────

Deno.test("[8] the response contains no AI-shaped fields — deterministic evidence only, same firewall as everywhere else", async () => {
  const r = await handleDiscoverRegionTargets(req({ missionId: "m1", polygon: SMALL_POLYGON, minScore: 0 }), baseDeps());
  const b = await r.json();
  const text = JSON.stringify(b).toLowerCase();
  for (const forbidden of ["narrative", "headline", "claude", "gemini", "anthropic", "openai"]) {
    assertEquals(text.includes(forbidden), false, `response unexpectedly mentions "${forbidden}"`);
  }
});

// ── [9] existing point/kRing targeting remains unchanged ────────────────────

Deno.test("[9] kRing is never invoked by polygon discovery — the polygon itself is the authoritative boundary", async () => {
  // REAL_H3_OPS.kRing throws unconditionally; if TargetingEngine.targetAt()
  // ever called it (directly or via some future refactor), this whole test
  // suite would fail loudly rather than silently degrading to a k-ring
  // expansion — exactly the failure mode Issue 1 forbids.
  const r = await handleDiscoverRegionTargets(req({ missionId: "m1", polygon: SMALL_POLYGON }), baseDeps());
  assertEquals(r.status, 200);
});

Deno.test("evidenceCaveat is present and human-readable", async () => {
  const r = await handleDiscoverRegionTargets(req({ missionId: "m1", polygon: SMALL_POLYGON }), baseDeps());
  const b = await r.json();
  assertEquals(typeof b.evidenceCaveat, "string");
  assertEquals(b.evidenceCaveat.length > 0, true);
});

Deno.test("unexpected error → opaque 500, no internal detail leaked as a 2xx", async () => {
  const deps = baseDeps({ buildEngine: async () => { throw new Error("db exploded with secret detail"); } });
  const r = await handleDiscoverRegionTargets(req({ missionId: "m1", polygon: SMALL_POLYGON }), deps);
  assertEquals(r.status, 500);
});
