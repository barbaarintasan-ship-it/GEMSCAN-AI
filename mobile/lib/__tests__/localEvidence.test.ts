// Local evidence overlay (Stage E5) — steps 6→7, evidence changes the guidance.
import { buildPack } from "../../../shared/geo-core/pack/build.ts";
import type { PackData } from "../../../shared/geo-core/pack/types.ts";
import { PackStore, createBundledPackSource } from "../geo/packStore.ts";
import { OfflineGeoContextService } from "../geo/offlineGeoContext.ts";
import { TargetingEngine } from "../geo/targeting.ts";
import { WaypointStore } from "../field/waypointStore";
import { WaypointService } from "../field/waypointService";
import type { SessionSnapshot } from "../field/types";
import {
  makeLocalEvidenceProvider,
  makeWaypointEvidenceSource,
  type LocalEvidenceSource,
} from "../exploration/localEvidence.ts";

const MOG = { lat: 2.0469, lng: 45.3182 };
const NOW = Date.parse("2026-08-03T00:00:00.000Z");

const BUILD_OPTS = {
  packId: "somalia", packVersion: "1.0.0", engineVersion: "1.0.0", region: "SO",
  h3Resolution: 7, builtAt: "2026-08-01T00:00:00.000Z", datasets: [],
};

function emptyData(): PackData {
  return {
    geology: [], occurrences: [], knowledge: [], structures: [], community: [], mapFeatures: [], terrain: [],
    associations: [], rules: [], commodities: [], assemblages: [],
  };
}

function memStore() {
  const data: Record<string, string> = {};
  return {
    getItem: async (k: string) => data[k] ?? null,
    setItem: async (k: string, v: string) => { data[k] = v; },
  };
}

function sessionAt(lat: number, lng: number, accuracy = 6): { getSnapshot(): SessionSnapshot } {
  return {
    getSnapshot: () => ({
      machine: { state: "active", pausedBy: null, errorCode: null },
      sessionId: "fs-1", startedAt: NOW,
      lastFix: { lat, lng, accuracy, altitude: null, speed: null, timestamp: NOW, provisional: false },
      lastHeading: null, fixCount: 1, headingSupported: true, degradedAccuracy: false, permission: null,
    }),
  };
}

async function waypointSourceWith(
  captures: { type: Parameters<WaypointService["capture"]>[0]["type"]; lat: number; lng: number }[],
): Promise<LocalEvidenceSource> {
  const store = new WaypointStore({
    storage: memStore(),
    photos: { persist: async () => "file:///x.jpg", remove: async () => {} },
  });
  // One service for every capture: ids are instance-scoped, so a fresh service
  // per capture would restart the counter and, with a frozen clock, collide.
  let at = { lat: 0, lng: 0 };
  const svc = new WaypointService({ getSnapshot: () => sessionAt(at.lat, at.lng).getSnapshot() }, store, () => NOW);
  for (const c of captures) {
    at = { lat: c.lat, lng: c.lng };
    await svc.capture({ type: c.type });
  }
  return makeWaypointEvidenceSource(store);
}

// ── The overlay reads real waypoints ───────────────────────────────────────
describe("waypoint evidence source", () => {
  test("captured waypoints become observations with distance and weight", async () => {
    const src = await waypointSourceWith([{ type: "sulfides", lat: MOG.lat, lng: MOG.lng }]);
    const obs = src.observationsNear(MOG.lat, MOG.lng, 10_000);
    expect(obs).toHaveLength(1);
    expect(obs[0].type).toBe("sulfides");
    expect(obs[0].distanceM).toBeLessThan(5);
    expect(obs[0].weight).toBeGreaterThan(0.5);
    expect(obs[0].statement).toContain("Sulfides");
  });

  test("a find outranks a place to look — the signal is not flat", async () => {
    const strong = await waypointSourceWith([{ type: "sulfides", lat: MOG.lat, lng: MOG.lng }]);
    const weak = await waypointSourceWith([{ type: "outcrop", lat: MOG.lat, lng: MOG.lng }]);
    expect(strong.observationsNear(MOG.lat, MOG.lng, 10_000)[0].weight)
      .toBeGreaterThan(weak.observationsNear(MOG.lat, MOG.lng, 10_000)[0].weight);
  });

  test("observations outside the radius are excluded, nearest come first", async () => {
    const src = await waypointSourceWith([
      { type: "gossan", lat: MOG.lat + 0.05, lng: MOG.lng },   // ~5.5 km
      { type: "gossan", lat: MOG.lat + 0.005, lng: MOG.lng },  // ~550 m
    ]);
    expect(src.observationsNear(MOG.lat, MOG.lng, 1_000)).toHaveLength(1);
    const both = src.observationsNear(MOG.lat, MOG.lng, 10_000);
    expect(both[0].distanceM).toBeLessThan(both[1].distanceM);
  });

  test("a waypoint with no position cannot be placed, so it is not evidence", async () => {
    const store = new WaypointStore({
      storage: memStore(),
      photos: { persist: async () => "f", remove: async () => {} },
    });
    const noFix = {
      getSnapshot: (): SessionSnapshot => ({
        machine: { state: "active", pausedBy: null, errorCode: null },
        sessionId: "fs-1", startedAt: NOW, lastFix: null, lastHeading: null,
        fixCount: 0, headingSupported: true, degradedAccuracy: false, permission: null,
      }),
    };
    await new WaypointService(noFix, store, () => NOW).capture({ type: "gossan" });
    expect(makeWaypointEvidenceSource(store).observationsNear(MOG.lat, MOG.lng, 10_000)).toEqual([]);
  });

  test("a degraded position weakens the observation rather than discarding it", async () => {
    const good = await waypointSourceWith([{ type: "gossan", lat: MOG.lat, lng: MOG.lng }]);
    const store = new WaypointStore({
      storage: memStore(),
      photos: { persist: async () => "f", remove: async () => {} },
    });
    // accuracy 80 m ⇒ "degraded" quality.
    await new WaypointService(sessionAt(MOG.lat, MOG.lng, 80), store, () => NOW).capture({ type: "gossan" });
    const degraded = makeWaypointEvidenceSource(store);

    const g = good.observationsNear(MOG.lat, MOG.lng, 10_000)[0];
    const d = degraded.observationsNear(MOG.lat, MOG.lng, 10_000)[0];
    expect(d.weight).toBeGreaterThan(0);      // still counts
    expect(d.weight).toBeLessThan(g.weight);  // but counts for less
    expect(d.statement).toContain("degraded");
  });
});

// ── The provider joins the GeoContext ──────────────────────────────────────
describe("local evidence provider", () => {
  test("observations appear in the on-device GeoContext, tagged as field observations", async () => {
    const src = await waypointSourceWith([{ type: "quartz-vein", lat: MOG.lat, lng: MOG.lng }]);
    const files = buildPack(emptyData(), BUILD_OPTS).files;
    const packs = new PackStore(createBundledPackSource(() => files), () => NOW);
    const geo = new OfflineGeoContextService(packs, "1.0.0", [makeLocalEvidenceProvider(src)]);

    const { context } = await geo.contextAt(MOG.lat, MOG.lng);
    expect(context.meta.providersRun).toContain("local_evidence");
    // An empty pack alone scores nothing; the observation is what lifts it.
    expect(context.confidence.score).toBeGreaterThan(0);
    expect(context.confidence.factors.join(" ")).toContain("Quartz vein");
  });

  test("with no observations the provider contributes nothing and never fails", async () => {
    const src = await waypointSourceWith([]);
    const files = buildPack(emptyData(), BUILD_OPTS).files;
    const packs = new PackStore(createBundledPackSource(() => files), () => NOW);
    const geo = new OfflineGeoContextService(packs, "1.0.0", [makeLocalEvidenceProvider(src)]);

    const { context } = await geo.contextAt(MOG.lat, MOG.lng);
    expect(context.meta.providersFailed).toEqual([]);
    expect(context.confidence.score).toBe(0);
  });
});

// ── The loop closes: evidence changes where you are sent ───────────────────
describe("evidence changes the recommendation", () => {
  test("finding sulfides raises the score of the ground you found them on", async () => {
    const files = buildPack(emptyData(), BUILD_OPTS).files;
    const packs = new PackStore(createBundledPackSource(() => files), () => NOW);

    const before = await new TargetingEngine(new OfflineGeoContextService(packs)).rank(MOG.lat, MOG.lng);
    expect(before.current.score).toBe(0); // empty pack, nothing observed

    const src = await waypointSourceWith([{ type: "sulfides", lat: MOG.lat, lng: MOG.lng }]);
    const after = await new TargetingEngine(new OfflineGeoContextService(packs), src)
      .rank(MOG.lat, MOG.lng);

    // Step 7: the model now knows something it did not before.
    expect(after.current.score).toBeGreaterThan(before.current.score);
  });

  test("an observation makes nearby ground a target where there was none", async () => {
    const files = buildPack(emptyData(), BUILD_OPTS).files;
    const packs = new PackStore(createBundledPackSource(() => files), () => NOW);

    // A find ~2 km NE — inside the k-ring, so neighbouring cells now score.
    const src = await waypointSourceWith([
      { type: "gossan", lat: MOG.lat + 0.018, lng: MOG.lng + 0.018 },
    ]);
    const withEvidence = await new TargetingEngine(new OfflineGeoContextService(packs), src)
      .rank(MOG.lat, MOG.lng);
    const without = await new TargetingEngine(new OfflineGeoContextService(packs))
      .rank(MOG.lat, MOG.lng);

    expect(without.targets).toEqual([]);
    expect(withEvidence.targets.length).toBeGreaterThan(0);
    expect(withEvidence.targets[0].reasons.join(" ")).toContain("Gossan");
  });
});
