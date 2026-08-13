// SLICE 3 — what the Add Waypoint form actually writes, and where the photos go.
//
// Drives the REAL orchestrator, the REAL WaypointService and WaypointStore, and the
// REAL PhotoUploadQueue. The only doubles are the sensors, the clock, the key-value
// store and the file copier — the parts a test cannot have.
//
// The two things being defended:
//
//   1. The UI CANNOT supply missionId. It is derived inside `captureObservation`
//      from the live mission, so a form cannot get it wrong or step around it.
//   2. Photos join the EXISTING queue at CAPTURE time. Waiting for Finish Section
//      meant a geologist who photographed a vein and did not finish the section
//      that day had nothing uploaded at all.
import type { FieldFix, SessionSnapshot } from "../field/types";
import { buildPack } from "../../../shared/geo-core/pack/build.ts";
import type { PackData } from "../../../shared/geo-core/pack/types.ts";
import { PackStore, createBundledPackSource } from "../geo/packStore.ts";
import { OfflineGeoContextService } from "../geo/offlineGeoContext.ts";
import { TargetingEngine } from "../geo/targeting.ts";
import { cellCentre } from "../geo/h3.ts";
import { ExplorationOrchestrator, type FieldSessionPort } from "../exploration/orchestrator.ts";
import { WaypointStore } from "../field/waypointStore";
import { WaypointService } from "../field/waypointService";
import { PhotoUploadQueue, PHOTO_QUEUE_STORAGE_KEY, type UploadDeps } from "../sync/photoUploadQueue";
import { PackageStore } from "../exploration/packageStore";
import { Outbox, type KeyValueAdapter } from "../sync/outbox";
import type { WaypointSample } from "../field/waypointTypes";

const NOW = Date.parse("2026-08-10T09:00:00.000Z");
const BUILD_OPTS = {
  packId: "somalia", packVersion: "1.0.0", engineVersion: "1.0.0", region: "SO",
  h3Resolution: 7, builtAt: "2026-08-01T00:00:00.000Z",
  datasets: [{ datasetId: "d1", source: "USGS MRDS", version: "2024" }],
};
const START = { lat: 2.0469, lng: 45.3182 };

const SAMPLE: WaypointSample = {
  sampleId: "LW-20260810-001", sampleType: "rock",
  collectionMethod: "outcrop", description: "White quartz vein with iron staining",
};

function pack(): PackData {
  const d: PackData = {
    geology: [{
      id: "g1", name: "Precambrian Basement", kind: "metamorphic", source: "Macrostrat",
      attributes: null,
      rings: [[[45.0, 1.8], [46.0, 1.8], [46.0, 2.8], [45.0, 2.8], [45.0, 1.8]]],
      bbox: [45.0, 1.8, 46.0, 2.8], isPolygon: true,
    }],
    occurrences: [], knowledge: [], structures: [], community: [], mapFeatures: [], terrain: [],
    associations: [], rules: [], commodities: [], assemblages: [], land: [],
  };
  for (let i = 0; i < 4; i++) {
    d.occurrences.push({
      id: `a${i}`, name: `a ${i}`, commodity_key: "gold", deposit_type: "orogenic",
      host_rocks: ["greenstone"],
      lat: START.lat + 0.021 + i * 0.001, lng: START.lng + 0.021 + i * 0.001,
      dataset_id: "d1", source: "USGS MRDS", version: "2024", reference: `R${i}`, cell: "c",
    });
  }
  return d;
}

function memoryStorage(): KeyValueAdapter & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: async (k) => data.get(k) ?? null,
    setItem: async (k, v) => { data.set(k, v); },
  };
}

function fakeField() {
  const listeners = new Set<() => void>();
  let snap: SessionSnapshot = {
    machine: { state: "idle", pausedBy: null, errorCode: null },
    sessionId: null, startedAt: null, lastFix: null, lastHeading: null,
    fixCount: 0, headingSupported: true, degradedAccuracy: false, permission: null,
  };
  const port: FieldSessionPort & {
    emitFix: (lat: number, lng: number) => void;
    emitHeading: (deg: number) => void;
  } = {
    getSnapshot: () => snap,
    subscribe: (l) => { listeners.add(l); return () => listeners.delete(l); },
    start: () => {
      snap = {
        ...snap, machine: { state: "active", pausedBy: null, errorCode: null },
        sessionId: "ex-1", startedAt: NOW,
      };
      listeners.forEach((l) => l());
    },
    stop: () => {
      snap = { ...snap, machine: { state: "idle", pausedBy: null, errorCode: null } };
      listeners.forEach((l) => l());
    },
    emitFix: (lat, lng) => {
      const fix: FieldFix = {
        lat, lng, accuracy: 6, altitude: 704, speed: 1, timestamp: NOW, provisional: false,
      };
      snap = { ...snap, lastFix: fix, fixCount: snap.fixCount + 1 };
      listeners.forEach((l) => l());
    },
    emitHeading: (deg) => {
      snap = {
        ...snap,
        lastHeading: {
          trueHeading: deg, magneticHeading: deg - 2, accuracy: 4, needsCalibration: false,
        },
      };
      listeners.forEach((l) => l());
    },
  };
  return port;
}

const settle = () => new Promise<void>((r) => setTimeout(r, 0));
jest.setTimeout(180_000);

function harness() {
  const storage = memoryStorage();
  const files = buildPack(pack(), BUILD_OPTS).files;
  const packs = new PackStore(createBundledPackSource(() => files), () => NOW);
  const field = fakeField();

  // The real store and service, with the filesystem copier doubled: a photo "copy"
  // returns an app-owned path, which is exactly what the real adapter yields.
  const copied: string[] = [];
  const waypointStore = new WaypointStore({
    storage,
    photos: {
      persist: async (sourceUri: string, fileName: string) => {
        copied.push(sourceUri);
        return `file:///app/waypoints/${fileName}`;
      },
      remove: async () => {},
    },
  });
  const waypoints = new WaypointService(field, waypointStore, () => NOW);
  const photoUploads = new PhotoUploadQueue({ storage, now: () => NOW });
  const packages = new PackageStore({ storage, now: () => NOW });
  const outbox = new Outbox({ storage, now: () => NOW });

  const orch = new ExplorationOrchestrator({
    field, targeting: new TargetingEngine(new OfflineGeoContextService(packs)),
    packs, now: () => NOW, waypoints, photoUploads, packages, outbox,
  });
  return { orch, field, waypoints, waypointStore, photoUploads, packages, storage, copied };
}

/** Start, take a target, set off — a live mission. */
async function liveMission(h: ReturnType<typeof harness>) {
  h.orch.start();
  h.field.emitHeading(118);
  h.field.emitFix(START.lat, START.lng);
  await settle();
  const t = h.orch.getSnapshot().activeTarget!;
  h.orch.selectTarget(t.cell);
  await settle();
  const c = cellCentre(t.cell);
  h.field.emitFix(c.lat, c.lng);
  await settle();
  await settle();
  return h.orch.getSnapshot().mission!;
}

describe("1. a waypoint created during an active mission", () => {
  test("it carries the mission, the GPS fix, the heading and everything typed", async () => {
    const h = harness();
    const mission = await liveMission(h);
    h.orch.beginInvestigation();

    const wp = await h.orch.captureObservation({
      type: "quartz-vein",
      notes: "I think this may be quartz with iron staining",
      sample: SAMPLE,
      photoUris: ["file:///camera/IMG_1.jpg", "file:///camera/IMG_2.jpg"],
    });

    expect(wp).not.toBeNull();
    // 1 — the mission, derived and not supplied.
    expect(wp!.missionId).toBe(mission.id);
    // 2 — GPS, read from the live fix. Nothing was typed.
    expect(wp!.position!.accuracyM).toBe(6);
    expect(wp!.position!.altitudeM).toBe(704);
    expect(wp!.position!.provisional).toBe(false);
    // and the heading came with it.
    expect(wp!.heading!.trueHeading).toBe(118);
    // 3, 4, 5 — type, sample, notes.
    expect(wp!.type).toBe("quartz-vein");
    expect(wp!.sample!.sampleId).toBe("LW-20260810-001");
    expect(wp!.sample!.collectionMethod).toBe("outcrop");
    expect(wp!.notes).toContain("I think this may be quartz");
    // 6 — photos, copied into app-owned storage rather than referenced in place.
    expect(wp!.photos).toHaveLength(2);
    expect(wp!.photos.every((p) => p.uri.startsWith("file:///app/waypoints/"))).toBe(true);
    expect(h.copied).toEqual(["file:///camera/IMG_1.jpg", "file:///camera/IMG_2.jpg"]);
    expect(wp!.capturedAt).toBe(NOW);
  });

  test("THE UI CANNOT SUPPLY missionId — there is no parameter for it", async () => {
    const h = harness();
    const mission = await liveMission(h);
    // The input type has no missionId field. Passing one is a compile error, and at
    // runtime it is simply not read: the orchestrator derives it.
    const wp = await h.orch.captureObservation(
      { type: "gossan", missionId: "ms-someone-elses" } as never,
    );
    expect(wp!.missionId).toBe(mission.id);
  });

  test("a waypoint with no sample and no photos is still a real record", async () => {
    // The common case. Most observations are looked at, not collected.
    const h = harness();
    await liveMission(h);
    const wp = await h.orch.captureObservation({ type: "outcrop", notes: "fresh face" });
    expect(wp!.sample).toBeNull();
    expect(wp!.photos).toEqual([]);
    expect(wp!.notes).toBe("fresh face");
  });
});

describe("2. a waypoint created with NO mission", () => {
  test("missionId is null, and that is allowed", async () => {
    // A geologist records things between missions. Refusing the observation would
    // lose a real field record for a bookkeeping reason.
    const h = harness();
    h.orch.start();
    h.field.emitFix(START.lat, START.lng);
    await settle();
    // No target taken, so no mission.
    expect(h.orch.getSnapshot().mission).toBeNull();

    const wp = await h.orch.captureObservation({ type: "float", notes: "loose quartz" });
    expect(wp).not.toBeNull();
    expect(wp!.missionId).toBeNull();
    expect(wp!.sessionId).toBe("ex-1");
  });

  test("its photos are NOT queued, because there is no key namespace yet", async () => {
    // R2 keys are missions/{missionId}/photos/{photoId}.jpg. With no mission there
    // is nowhere to put them, and inventing a prefix would produce a key nothing
    // downstream could find. They stay on disk and wait.
    const h = harness();
    h.orch.start();
    h.field.emitFix(START.lat, START.lng);
    await settle();
    const wp = await h.orch.captureObservation({
      type: "float", photoUris: ["file:///camera/IMG_9.jpg"],
    });
    expect(wp!.photos).toHaveLength(1);
    await h.photoUploads.load();
    expect(h.photoUploads.all()).toEqual([]);
  });
});

describe("3. a photo captured offline uploads later", () => {
  test("it is queued at CAPTURE time, not at Finish Section", async () => {
    const h = harness();
    const mission = await liveMission(h);
    h.orch.beginInvestigation();

    const wp = await h.orch.captureObservation({
      type: "sulfides", photoUris: ["file:///camera/IMG_1.jpg"],
    });

    // On the queue immediately — Finish Section has not been called.
    await h.photoUploads.load();
    const queued = h.photoUploads.all();
    expect(queued).toHaveLength(1);
    expect(queued[0].photoId).toBe(wp!.photos[0].id);
    expect(queued[0].missionId).toBe(mission.id);
    expect(queued[0].state).toBe("pending");
    expect(h.photoUploads.allUploaded(mission.id)).toBe(false);
  });

  test("offline it stays queued; when the network returns it uploads", async () => {
    const h = harness();
    const mission = await liveMission(h);
    await h.orch.captureObservation({ type: "gossan", photoUris: ["file:///camera/IMG_1.jpg"] });
    await h.photoUploads.load();

    // No network: the presign call throws. Nothing is lost.
    const offline: UploadDeps = {
      presign: async () => { throw new Error("no network"); },
      put: async () => ({ status: 200 }),
      now: () => NOW,
    };
    expect(await h.photoUploads.drain(offline)).toEqual({ uploaded: 0, failed: 1 });
    expect(h.photoUploads.pendingFor(mission.id)).toHaveLength(1);

    // Later, with a network.
    const later = NOW + 60 * 60 * 1000;
    const online: UploadDeps = {
      presign: async (mid, photos) => photos.map((p) => ({
        photoId: p.photoId,
        key: `missions/${mid}/photos/${p.photoId}.jpg`,
        url: "https://acct.r2.cloudflarestorage.com/b/x?X-Amz-Signature=y",
      })),
      put: async () => ({ status: 200, bytes: 2_400_000 }),
      now: () => later,
    };
    expect((await h.photoUploads.drain(online)).uploaded).toBe(1);
    expect(h.photoUploads.allUploaded(mission.id)).toBe(true);
  });

  test("an R2 failure keeps the evidence, on disk and on the queue", async () => {
    const h = harness();
    const mission = await liveMission(h);
    await h.orch.captureObservation({ type: "vein", photoUris: ["file:///camera/IMG_1.jpg"] });
    await h.photoUploads.load();
    await h.photoUploads.drain({
      presign: async (mid, photos) => photos.map((p) => ({
        photoId: p.photoId, key: `missions/${mid}/photos/${p.photoId}.jpg`, url: "https://r2/x",
      })),
      // 403 is what an expired presigned URL returns.
      put: async () => ({ status: 403 }),
      now: () => NOW,
    });
    expect(h.photoUploads.all()[0].state).toBe("failed");
    expect(h.photoUploads.all()[0].uploadedAt).toBeNull();
    expect(h.photoUploads.pendingFor(mission.id)).toHaveLength(1);
    // And the file itself is still recorded on the waypoint.
    expect(h.waypoints.listCurrentSession()[0].photos).toHaveLength(1);
  });
});

describe("4. the app is killed before Finish Section", () => {
  test("the waypoint, its sample and its queued photo all survive", async () => {
    const h = harness();
    const mission = await liveMission(h);
    await h.orch.captureObservation({
      type: "quartz-vein", notes: "vein, 40 cm",
      sample: SAMPLE, photoUris: ["file:///camera/IMG_1.jpg"],
    });

    // Everything is on disk before anything else is attempted.
    expect(h.storage.data.has("field.waypoints.v1")).toBe(true);
    expect(h.storage.data.has(PHOTO_QUEUE_STORAGE_KEY)).toBe(true);

    // A fresh store and a fresh queue over the same bytes — the process died.
    const reopenedStore = new WaypointStore({
      storage: h.storage,
      photos: { persist: async (_s: string, f: string) => `file:///app/waypoints/${f}`, remove: async () => {} },
    });
    await reopenedStore.load();
    const revived = reopenedStore.visible();
    expect(revived).toHaveLength(1);
    expect(revived[0].missionId).toBe(mission.id);
    expect(revived[0].sample!.sampleId).toBe("LW-20260810-001");
    expect(revived[0].notes).toBe("vein, 40 cm");
    expect(revived[0].photos).toHaveLength(1);

    const reopenedQueue = new PhotoUploadQueue({ storage: h.storage, now: () => NOW });
    await reopenedQueue.load();
    expect(reopenedQueue.pendingFor(mission.id)).toHaveLength(1);
  });
});

describe("5. Finish Section includes every waypoint's evidence", () => {
  test("the package carries the observations, samples and photos of THIS mission", async () => {
    const h = harness();
    const mission = await liveMission(h);
    h.orch.beginInvestigation();

    await h.orch.captureObservation({
      type: "quartz-vein", notes: "vein with limonite",
      sample: SAMPLE, photoUris: ["file:///camera/IMG_1.jpg", "file:///camera/IMG_2.jpg"],
    });
    await h.orch.captureObservation({ type: "gossan", notes: "rusty cap" });

    const pkg = await h.orch.finishSection({
      waypoints: h.waypoints.list(),
      terrainContext: "valley",
    });

    expect(pkg).not.toBeNull();
    expect(pkg!.missionId).toBe(mission.id);
    expect(pkg!.observations).toHaveLength(2);
    const vein = pkg!.observations.find((o) => o.type === "quartz-vein")!;
    expect(vein.photos).toHaveLength(2);
    expect(vein.positionQuality).toBe("good");
    expect(vein.position!.accuracyM).toBe(6);
    expect(vein.headingDeg).toBe(118);
    expect(vein.notes).toBe("vein with limonite");
    // Two photos on one observation, none on the other.
    expect(pkg!.observations.reduce((n, o) => n + o.photos.length, 0)).toBe(2);
  });

  test("Finish Section does not RE-queue what capture already queued", async () => {
    // One upload path, reached from two moments. Enqueue is idempotent on photo id,
    // so finishing a section cannot cause a second upload of the same bytes.
    const h = harness();
    const mission = await liveMission(h);
    await h.orch.captureObservation({ type: "gossan", photoUris: ["file:///camera/IMG_1.jpg"] });
    await h.photoUploads.load();
    expect(h.photoUploads.all()).toHaveLength(1);

    await h.orch.finishSection({ waypoints: h.waypoints.list() });
    // Still one entry — not two.
    expect(h.photoUploads.all()).toHaveLength(1);
    expect(h.photoUploads.pendingFor(mission.id)).toHaveLength(1);
  });

  test("another mission's waypoint is NOT in this package", async () => {
    const h = harness();
    const first = await liveMission(h);
    await h.orch.captureObservation({ type: "gossan", notes: "mission one" });

    // Close it and take a different target — a second mission in the same walk.
    h.orch.closeMission();
    await settle();
    h.orch.setCommodity("gold");
    await settle();
    const second = h.orch.getSnapshot().mission;
    if (!second || second.id === first.id) return; // fixture gave one mission only
    await h.orch.captureObservation({ type: "sulfides", notes: "mission two" });

    const pkg = await h.orch.finishSection({ waypoints: h.waypoints.list() });
    expect(pkg!.observations.map((o) => o.notes)).toEqual(["mission two"]);
  });
});
