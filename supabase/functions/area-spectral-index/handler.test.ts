// Integration-shaped tests for area-spectral-index with injected dependencies
// (no live CDSE call, no live Supabase stack) — Phase 16 (Remote-Sensing
// Spectral Intelligence). Verifies the auth/membership/ownership gates, the
// cache-freshness short-circuit (the primary quota-protection mechanism),
// best-interval selection (clearest, not just most recent), the honest
// "no usable acquisition" path, and error mapping.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  handleAreaSpectralIndex, pickBestInterval, metreBufferToDegBbox, degBboxToMercator,
  type SpectralDeps, type SpectralRow,
} from "./handler.ts";
import type { Actor } from "../_shared/enterprise/auth.ts";

const OWNER: Actor = { userId: "owner-1", email: "owner@example.com", contributorId: "c1", role: "admin" };

function req(body?: Record<string, unknown>, method = "POST"): Request {
  return new Request("https://x/area-spectral-index", { method, body: body ? JSON.stringify(body) : undefined });
}

function baseDeps(overrides: Partial<SpectralDeps> = {}): SpectralDeps {
  return {
    resolveActor: async () => OWNER,
    isMissionMember: async () => true,
    areaBelongsToMission: async () => true,
    fetchAreaLocation: async () => ({ lat: 9.5, lng: 44.5 }),
    fetchCached: async () => null,
    fetchToken: async () => "fake-token",
    fetchStatistics: async () => ({ data: [] }),
    persist: async (_m, _a, row, _by, _raw) => ({ ...row, computed_at: "2026-09-24T00:00:00.000Z" }),
    now: () => new Date("2026-09-24T00:00:00.000Z"),
    ...overrides,
  };
}

Deno.test("OPTIONS returns CORS preflight ok", async () => {
  const r = await handleAreaSpectralIndex(req(undefined, "OPTIONS"), baseDeps());
  assertEquals(r.status, 200);
});

Deno.test("missing missionId/areaId → 400 bad_request", async () => {
  const r = await handleAreaSpectralIndex(req({}), baseDeps());
  assertEquals(r.status, 400);
  assertEquals((await r.json()).code, "bad_request");
});

Deno.test("caller not a mission member → 403 forbidden", async () => {
  const deps = baseDeps({ isMissionMember: async () => false });
  const r = await handleAreaSpectralIndex(req({ missionId: "m1", areaId: "a1" }), deps);
  assertEquals(r.status, 403);
});

Deno.test("area does not belong to mission → 404 not_found", async () => {
  const deps = baseDeps({ areaBelongsToMission: async () => false });
  const r = await handleAreaSpectralIndex(req({ missionId: "m1", areaId: "a1" }), deps);
  assertEquals(r.status, 404);
});

Deno.test("[quota] a fresh cached row is returned WITHOUT calling CDSE at all", async () => {
  let tokenCalls = 0;
  let statsCalls = 0;
  const cached: SpectralRow = {
    index_name: "iron_oxide_ratio", value: 1.8, acquisition_date: "2026-09-15",
    cloud_fraction: 0.05, valid_pixel_fraction: 0.99, resolution_m: 10,
    source: "Sentinel-2 L2A (Copernicus Data Space Ecosystem)",
    computed_at: "2026-09-15T00:00:00.000Z", // 9 days before `now` — inside the 14-day freshness window
  };
  const deps = baseDeps({
    fetchCached: async () => cached,
    fetchToken: async () => { tokenCalls++; return "t"; },
    fetchStatistics: async () => { statsCalls++; return { data: [] }; },
  });
  const r = await handleAreaSpectralIndex(req({ missionId: "m1", areaId: "a1" }), deps);
  assertEquals(r.status, 200);
  const b = await r.json();
  assertEquals(b.cacheHit, true);
  assertEquals(b.value, 1.8);
  assertEquals(tokenCalls, 0);
  assertEquals(statsCalls, 0);
});

Deno.test("a stale cached row (older than freshness window) triggers a fresh CDSE call", async () => {
  const stale: SpectralRow = {
    index_name: "iron_oxide_ratio", value: 1.2, acquisition_date: "2026-08-01",
    cloud_fraction: 0.4, valid_pixel_fraction: 0.9, resolution_m: 10,
    source: "Sentinel-2 L2A (Copernicus Data Space Ecosystem)",
    computed_at: "2026-08-01T00:00:00.000Z", // 54 days before `now`
  };
  let statsCalls = 0;
  const deps = baseDeps({
    fetchCached: async () => stale,
    fetchStatistics: async () => { statsCalls++; return { data: [] }; },
  });
  const r = await handleAreaSpectralIndex(req({ missionId: "m1", areaId: "a1" }), deps);
  assertEquals(r.status, 200);
  assertEquals(statsCalls, 1);
});

Deno.test("real acquisition → persists and returns the clearest interval's value, not the most recent", async () => {
  const stats = {
    data: [
      { interval: { from: "2026-09-01T00:00:00Z" }, outputs: {
        index: { bands: { B0: { stats: { mean: 2.1, sampleCount: 100, noDataCount: 0 } } } },
        cloud: { bands: { B0: { stats: { mean: 0.6 } } } }, // heavily clouded
      } },
      { interval: { from: "2026-08-20T00:00:00Z" }, outputs: {
        index: { bands: { B0: { stats: { mean: 1.4, sampleCount: 100, noDataCount: 5 } } } },
        cloud: { bands: { B0: { stats: { mean: 0.02 } } } }, // clear, but older
      } },
    ],
  };
  let persisted: any = null;
  const deps = baseDeps({
    fetchStatistics: async () => stats,
    persist: async (_m, _a, row, _by, raw) => { persisted = { row, raw }; return { ...row, computed_at: "2026-09-24T00:00:00.000Z" }; },
  });
  const r = await handleAreaSpectralIndex(req({ missionId: "m1", areaId: "a1" }), deps);
  assertEquals(r.status, 200);
  const b = await r.json();
  assertEquals(b.value, 1.4);
  assertEquals(b.acquisition_date, "2026-08-20");
  assertEquals(persisted.row.cloud_fraction, 0.02);
  assertEquals(Math.round(persisted.row.valid_pixel_fraction * 100), 95);
});

Deno.test("no usable acquisition in the search window → honest null result, not an error", async () => {
  const deps = baseDeps({ fetchStatistics: async () => ({ data: [] }) });
  const r = await handleAreaSpectralIndex(req({ missionId: "m1", areaId: "a1" }), deps);
  assertEquals(r.status, 200);
  const b = await r.json();
  assertEquals(b.value, null);
  assertEquals(typeof b.note, "string");
});

Deno.test("[pickBestInterval] ignores an interval with zero valid samples", () => {
  const best = pickBestInterval({
    data: [
      { interval: { from: "2026-09-01T00:00:00Z" }, outputs: {
        index: { bands: { B0: { stats: { mean: 5, sampleCount: 100, noDataCount: 100 } } } },
        cloud: { bands: { B0: { stats: { mean: 0 } } } },
      } },
    ],
  });
  assertEquals(best, null);
});

Deno.test("missing/invalid JWT → 401 via errorResponse", async () => {
  const deps = baseDeps({ resolveActor: async () => { throw new (await import("../_shared/enterprise/errors.ts")).UnauthorizedError(); } });
  const r = await handleAreaSpectralIndex(req({ missionId: "m1", areaId: "a1" }), deps);
  assertEquals(r.status, 401);
});

Deno.test("unexpected error → opaque 500, no internal detail leaked as a 2xx", async () => {
  const deps = baseDeps({ fetchToken: async () => { throw new Error("Sentinel Hub OAuth failed: invalid_client"); } });
  const r = await handleAreaSpectralIndex(req({ missionId: "m1", areaId: "a1" }), deps);
  assertEquals(r.status, 500);
});

// ── pure math helpers ───────────────────────────────────────────────────────

Deno.test("[bbox] metreBufferToDegBbox produces a box centred on the point", () => {
  const [minLng, minLat, maxLng, maxLat] = metreBufferToDegBbox(9.5, 44.5, 500);
  assertEquals(Math.abs((minLng + maxLng) / 2 - 44.5) < 1e-9, true);
  assertEquals(Math.abs((minLat + maxLat) / 2 - 9.5) < 1e-9, true);
  // ~500m in degrees latitude should be small, well under a tenth of a degree
  assertEquals(maxLat - minLat < 0.01, true);
});

Deno.test("[bbox] degBboxToMercator preserves ordering (min < max on both axes)", () => {
  const merc = degBboxToMercator([44.49, 9.49, 44.51, 9.51]);
  assertEquals(merc[0] < merc[2], true);
  assertEquals(merc[1] < merc[3], true);
});
