// Unit tests for the GeoContext runtime engine core (no DB, no LLM): priority
// conflict resolution, confidence model, evidence fusion, and engine orchestration
// (parallel execution, failure isolation, cache integration).
import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { resolveConflict } from "./priority.ts";
import { bandFor, computeConfidence } from "./confidence.ts";
import { fuse } from "./fusion.ts";
import { GeoContextEngine } from "./engine.ts";
import type { CacheStore, GeoContext, GeoContextProvider, ProviderContribution } from "./types.ts";

// ── priority ───────────────────────────────────────────────────────────────
Deno.test("resolveConflict: highest priority wins, alternatives retained", () => {
  const r = resolveConflict([
    { value: "schist", source: "knowledge", priority: 30 },
    { value: "granite", source: "geology", priority: 10 },
  ])!;
  assertEquals(r.value, "granite");
  assertEquals(r.source, "geology");
  assertEquals(r.alternatives, [{ value: "schist", source: "knowledge" }]);
});

Deno.test("resolveConflict: all-empty returns null", () => {
  assertEquals(resolveConflict([{ value: undefined, source: "x", priority: 1 }]), null);
});

// ── confidence ───────────────────────────────────────────────────────────────
Deno.test("confidence: noisy-OR rises with corroboration; bands correct", () => {
  const one = computeConfidence([{ statement: "a", weight: 0.5 }]);
  const many = computeConfidence([
    { statement: "a", weight: 0.5 },
    { statement: "b", weight: 0.5 },
    { statement: "c", weight: 0.5 },
  ]);
  assert(many.score > one.score, "more evidence => higher score");
  assertEquals(bandFor(0.2), "Low");
  assertEquals(bandFor(0.5), "Moderate");
  assertEquals(bandFor(0.9), "High");
});

Deno.test("confidence: empty evidence => Low, explains absence", () => {
  const c = computeConfidence([]);
  assertEquals(c.score, 0);
  assertEquals(c.overall, "Low");
  assert(c.factors.some((f) => /no supporting evidence/i.test(f)));
});

Deno.test("confidence: tier lowers effective weight (community < lab)", () => {
  const community = computeConfidence([{ statement: "x", weight: 0.8, tier: "community" }]);
  const lab = computeConfidence([{ statement: "x", weight: 0.8, tier: "lab_verified" }]);
  assert(lab.score > community.score);
});

// ── fusion ───────────────────────────────────────────────────────────────────
function contrib(over: Partial<ProviderContribution>): ProviderContribution {
  return { provider: "p", category: "spatial", priority: 50, data: {}, evidence: [], confidence: 0.5, ...over };
}

Deno.test("fuse: arrays concatenated, hostRocks deduped, scalars by priority", () => {
  const res = fuse([
    contrib({ provider: "geology", priority: 10, data: { geology: { unit: "Granite" }, hostRocks: ["quartz vein"] },
      evidence: [{ statement: "mapped granite", weight: 0.8 }] }),
    contrib({ provider: "knowledge", priority: 30, data: { geology: { unit: "Schist" }, hostRocks: ["quartz vein", "ultramafic"] },
      evidence: [{ statement: "reported schist", weight: 0.4 }] }),
  ]);
  assertEquals(res.data.geology.unit, "Granite"); // priority winner
  assertEquals((res.data as { geologyAlternatives?: Record<string, unknown> }).geologyAlternatives!.unit,
    [{ value: "Schist", source: "knowledge" }]);
  assertEquals(res.data.hostRocks.sort(), ["quartz vein", "ultramafic"]);
  assertEquals(res.reasoningFactors, ["mapped granite", "reported schist"]); // ranked by weight
});

// ── engine ───────────────────────────────────────────────────────────────────
function provider(name: string, priority: number, c: Partial<ProviderContribution>, opts: { fail?: boolean } = {}): GeoContextProvider {
  return {
    name, category: "spatial", priority,
    fetch: () => opts.fail ? Promise.reject(new Error("boom")) : Promise.resolve(contrib({ provider: name, priority, ...c })),
  };
}

const Q = { lat: 2, lng: 45, radiusM: 1000, h3: "8a2a1072b59ffff" };

Deno.test("engine: assembles JSON, runs providers in parallel", async () => {
  const engine = new GeoContextEngine({
    engineVersion: "v1",
    providers: [
      provider("geology", 10, { data: { geology: { unit: "Granite" } }, evidence: [{ statement: "mapped granite", weight: 0.7 }] }),
      provider("occurrence", 20, { data: { knownOccurrences: [{ commodity: "Au", distanceM: 400 }] }, evidence: [{ statement: "Au occurrence 400 m", weight: 0.6 }] }),
    ],
    now: () => new Date("2026-07-27T00:00:00Z"),
  });
  const ctx = await engine.run(Q);
  assertEquals(ctx.location.lat, 2);
  assertEquals(ctx.geology.unit, "Granite");
  assertEquals(ctx.knownOccurrences.length, 1);
  assertEquals(ctx.meta.providersRun.sort(), ["geology", "occurrence"]);
  assertEquals(ctx.meta.cache, "miss");
  assert(ctx.reasoningFactors.length >= 2);
  // never asserts presence — output is evidence + confidence, no boolean claim:
  assert(typeof ctx.confidence.overall === "string");
  assert(!("hasGold" in ctx));
});

Deno.test("engine: a failing provider is isolated, request still succeeds", async () => {
  const engine = new GeoContextEngine({
    engineVersion: "v1",
    providers: [
      provider("geology", 10, { evidence: [{ statement: "mapped granite", weight: 0.7 }] }),
      provider("occurrence", 20, {}, { fail: true }),
    ],
  });
  const ctx = await engine.run(Q);
  assertEquals(ctx.meta.providersRun, ["geology"]);
  assertEquals(ctx.meta.providersFailed, ["occurrence"]);
  assert(ctx.confidence.factors.some((f) => /unavailable/i.test(f)));
});

Deno.test("engine: cache hit short-circuits; miss writes through", async () => {
  const store = new Map<string, GeoContext>();
  const cache: CacheStore = {
    get: (h3, v) => Promise.resolve(store.get(`${h3}:${v}`) ?? null),
    set: (h3, v, ctx) => { store.set(`${h3}:${v}`, ctx); return Promise.resolve(); },
  };
  const engine = new GeoContextEngine({
    engineVersion: "v1", cache,
    providers: [provider("geology", 10, { evidence: [{ statement: "mapped", weight: 0.7 }] })],
  });
  const first = await engine.run(Q);
  assertEquals(first.meta.cache, "miss");
  const second = await engine.run(Q);
  assertEquals(second.meta.cache, "hit");
});
