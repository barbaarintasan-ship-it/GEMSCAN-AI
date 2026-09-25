// Integration-shaped tests for the team-targeting handler with injected
// dependencies (no live Supabase stack, no live geo schema): verifies the
// JWT→entitlement flow, request validation, the ranking response shape, the
// opt-in hotspot call, and error mapping. Solo→Team shared-targeting Phase 1.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { handleTeamTargeting, MAX_RINGS, MAX_TARGETING_LIMIT, type TeamTargetingDeps } from "./handler.ts";
import type { Actor } from "../_shared/enterprise/auth.ts";
import { ForbiddenError, UnauthorizedError } from "../_shared/enterprise/errors.ts";
import { TargetingEngine, type H3Ops, type GeoContextBatchSource } from "../../../shared/geo-core/gie/targetingEngine.ts";
import { packWithMapFeatures } from "../_shared/geocontext/structuralPack.ts";
import type { GeoContext } from "../../../shared/geo-core/types.ts";
import type { PackCommodityProfile, PackMapFeature } from "../../../shared/geo-core/pack/types.ts";

const OWNER: Actor = { userId: "owner-1", email: "owner@example.com", contributorId: "c1", role: "admin" };

function req(body?: Record<string, unknown>, method = "POST"): Request {
  return new Request("https://x/team-targeting", {
    method,
    body: body ? JSON.stringify(body) : undefined,
  });
}

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

/** A fake GeoContextBatchSource that always returns one occurrence 500m from
 *  the queried point — enough for the engine to offer at least one target,
 *  without touching a live database. */
function fakeGeoWithOccurrenceEverywhere(): GeoContextBatchSource {
  const query = async (lat: number, lng: number) => {
    const ctx = emptyContext(lat, lng);
    ctx.knownOccurrences = [{ commodity: "Gold", distanceM: 500 }];
    return { context: ctx, hasKnowledge: true };
  };
  return { contextAt: query, openBatch: async () => query };
}

const FAKE_H3: H3Ops = {
  cellFor: (lat, lng) => `${lat.toFixed(2)},${lng.toFixed(2)}`,
  cellCentre: (cell) => { const [lat, lng] = cell.split(",").map(Number); return { lat, lng }; },
  // A tiny, fixed 2-cell "ring" so the test never depends on real h3-js geometry.
  kRing: (cell) => {
    const [lat, lng] = cell.split(",").map(Number);
    return [cell, `${(lat + 0.05).toFixed(2)},${lng.toFixed(2)}`];
  },
};

function baseDeps(overrides: Partial<TeamTargetingDeps> = {}): TeamTargetingDeps {
  return {
    resolveActor: async () => OWNER,
    requireEnterprise: async () => {},
    buildEngine: async () => new TargetingEngine(fakeGeoWithOccurrenceEverywhere(), FAKE_H3),
    findHotspot: async () => null,
    ...overrides,
  };
}

Deno.test("OPTIONS returns CORS preflight ok", async () => {
  const r = await handleTeamTargeting(req(undefined, "OPTIONS"), baseDeps());
  assertEquals(r.status, 200);
});

Deno.test("missing lat/lng → 400 bad_request", async () => {
  const r = await handleTeamTargeting(req({}), baseDeps());
  assertEquals(r.status, 400);
  const b = await r.json();
  assertEquals(b.code, "bad_request");
});

Deno.test("out-of-range lat/lng → 400 bad_request", async () => {
  const r = await handleTeamTargeting(req({ lat: 999, lng: 44 }), baseDeps());
  assertEquals(r.status, 400);
});

Deno.test("valid request returns ranked targets from the shared TargetingEngine", async () => {
  const r = await handleTeamTargeting(req({ lat: 9.5, lng: 44.5 }), baseDeps());
  assertEquals(r.status, 200);
  const b = await r.json();
  assertEquals(typeof b.current.score, "number");
  assertEquals(Array.isArray(b.targets), true);
  assertEquals(b.targets.length > 0, true);
  assertEquals(typeof b.targets[0].score, "number");
  assertEquals(typeof b.evidenceCaveat, "string");
  // Phase 1 does not compute a hotspot unless explicitly requested.
  assertEquals(b.hotspot, null);
});

Deno.test("hotspot is only computed when explicitly requested", async () => {
  let hotspotCalls = 0;
  const deps = baseDeps({
    findHotspot: async () => { hotspotCalls++; return { lat: 9.5, lng: 44.5, cell: "x", score: 0.5, liftOverCentre: 0.1 }; },
  });
  const withoutFlag = await handleTeamTargeting(req({ lat: 9.5, lng: 44.5 }), deps);
  assertEquals((await withoutFlag.json()).hotspot, null);
  assertEquals(hotspotCalls, 0);

  const withFlag = await handleTeamTargeting(req({ lat: 9.5, lng: 44.5, hotspot: true }), deps);
  const body = await withFlag.json();
  assertEquals(body.hotspot?.cell, "x");
  assertEquals(hotspotCalls, 1);
});

Deno.test("caller not enterprise-enabled → 403 via errorResponse", async () => {
  const deps = baseDeps({ requireEnterprise: async () => { throw new ForbiddenError("enterprise not enabled"); } });
  const r = await handleTeamTargeting(req({ lat: 9.5, lng: 44.5 }), deps);
  assertEquals(r.status, 403);
});

Deno.test("missing/invalid JWT → 401 via errorResponse", async () => {
  const deps = baseDeps({ resolveActor: async () => { throw new UnauthorizedError("invalid or expired token"); } });
  const r = await handleTeamTargeting(req({ lat: 9.5, lng: 44.5 }), deps);
  assertEquals(r.status, 401);
});

Deno.test("[structural evidence] buildEngine receives the query point + radius, not just called blind", async () => {
  let received: [number, number, number] | null = null;
  const deps = baseDeps({
    buildEngine: async (lat, lng, radiusM) => {
      received = [lat, lng, radiusM];
      return new TargetingEngine(fakeGeoWithOccurrenceEverywhere(), FAKE_H3);
    },
  });
  await handleTeamTargeting(req({ lat: 11.08838, lng: 49.01769, radiusM: 25000 }), deps);
  assertEquals(received, [11.08838, 49.01769, 25000]);
});

// ── Phase 15 — region-wide discovery caps ───────────────────────────────────

Deno.test("[Phase 15] rings beyond MAX_RINGS is refused loudly, not silently reduced", async () => {
  const r = await handleTeamTargeting(req({ lat: 9.5, lng: 44.5, rings: MAX_RINGS + 1 }), baseDeps());
  assertEquals(r.status, 400);
  const b = await r.json();
  assertEquals(b.code, "bad_request");
});

Deno.test("[Phase 15] rings at exactly MAX_RINGS is accepted", async () => {
  let receivedRings: number | undefined;
  const deps = baseDeps({
    buildEngine: async () => {
      const engine = new TargetingEngine(fakeGeoWithOccurrenceEverywhere(), FAKE_H3);
      const realRank = engine.rank.bind(engine);
      engine.rank = (lat, lng, opts) => { receivedRings = opts?.rings; return realRank(lat, lng, opts); };
      return engine;
    },
  });
  const r = await handleTeamTargeting(req({ lat: 9.5, lng: 44.5, rings: MAX_RINGS }), deps);
  assertEquals(r.status, 200);
  assertEquals(receivedRings, MAX_RINGS);
});

Deno.test("[Phase 15] limit beyond MAX_TARGETING_LIMIT is silently clamped — harmless, so no error needed", async () => {
  let receivedLimit: number | undefined;
  const deps = baseDeps({
    buildEngine: async () => {
      const engine = new TargetingEngine(fakeGeoWithOccurrenceEverywhere(), FAKE_H3);
      const realRank = engine.rank.bind(engine);
      engine.rank = (lat, lng, opts) => { receivedLimit = opts?.limit; return realRank(lat, lng, opts); };
      return engine;
    },
  });
  const r = await handleTeamTargeting(req({ lat: 9.5, lng: 44.5, limit: MAX_TARGETING_LIMIT + 100 }), deps);
  assertEquals(r.status, 200);
  assertEquals(receivedLimit, MAX_TARGETING_LIMIT);
});

Deno.test("unexpected error is mapped to an opaque 500, no internal detail leaked", async () => {
  const deps = baseDeps({ buildEngine: async () => { throw new Error("db exploded with secret detail"); } });
  const r = await handleTeamTargeting(req({ lat: 9.5, lng: 44.5 }), deps);
  assertEquals(r.status, 500);
  const b = await r.json();
  assertEquals(b.error, "internal error");
  assertEquals(String(b.detail).includes("secret"), true); // owner-beta detail surfacing, same as geocontext
});

// ── [pack.commodities fix, 2026-09-25] a real commodity profile must genuinely
// change scoring here too — team-targeting had the identical bug as
// discover-region-targets (pack.commodities always []). Same drainage-gate
// proof: an empty geo context plus a mapped drainage channel right at the
// query point produces NO evidence at all (current.score === 0) unless a
// populated placer-family commodity profile reaches the pack.

const GOLD_PLACER_PROFILE: PackCommodityProfile = {
  code: "gold", name: "Gold", category: "metal",
  typical_host_rocks: null, associated_minerals: null, alteration_styles: null,
  deposit_models: ["placer / alluvial"], tectonic_settings: null,
  exploration_indicators: null, industrial_uses: null,
  is_critical_mineral: null, strategic_importance: null, confidence_limitations: "",
};

function drainageFeatureAt(lat: number, lng: number): PackMapFeature {
  const lines: [number, number][][] = [[[lng - 0.01, lat], [lng + 0.01, lat]]];
  return {
    id: "drainage-1", kind: "drainage", name: null, source: "test",
    attributes: null, lines,
    bbox: [lng - 0.01, lat, lng + 0.01, lat],
  };
}

function emptyGeoBatchSource(): GeoContextBatchSource {
  const query = async (lat: number, lng: number) => ({ context: emptyContext(lat, lng), hasKnowledge: true });
  return { contextAt: query, openBatch: async () => query };
}

/** Mimics the REAL (fixed) buildEngine wiring: the commodity profile only
 *  reaches the pack when a commodity was actually requested. */
function depsWithDrainageAt(lat: number, lng: number) {
  return baseDeps({
    buildEngine: async (_lat, _lng, _radiusM, commodity) =>
      new TargetingEngine(
        emptyGeoBatchSource(), FAKE_H3, undefined,
        () => packWithMapFeatures([drainageFeatureAt(lat, lng)], commodity ? [GOLD_PLACER_PROFILE] : []),
      ),
  });
}

Deno.test("[pack.commodities fix] with NO commodity selected, a drainage-only point scores 0 — the role never activates", async () => {
  const deps = depsWithDrainageAt(9.5, 44.5);
  const r = await handleTeamTargeting(req({ lat: 9.5, lng: 44.5 }), deps);
  const b = await r.json();
  assertEquals(b.current.score, 0);
});

Deno.test("[pack.commodities fix] selecting a placer commodity (gold) activates drainage evidence and the point scores > 0", async () => {
  const deps = depsWithDrainageAt(9.5, 44.5);
  const r = await handleTeamTargeting(req({ lat: 9.5, lng: 44.5, commodity: "gold" }), deps);
  const b = await r.json();
  assertEquals(b.current.score > 0, true, "with gold selected, drainage evidence must produce a real score at this point");
});
