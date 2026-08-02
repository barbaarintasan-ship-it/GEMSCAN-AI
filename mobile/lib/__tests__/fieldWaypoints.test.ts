// Field Exploration Engine — Milestone 2.1 unit tests (waypoints).
//
// Pure tests with injected adapters: no AsyncStorage, no filesystem, no expo.
// The Phase 1 controller is represented by its snapshot, which is the only
// thing the service is allowed to read from it.
import type { FieldFix, FieldHeading, SessionSnapshot } from "../field/types";
import {
  WAYPOINT_DEGRADED_ACCURACY_M,
  WAYPOINT_STALE_FIX_MS,
  WAYPOINT_TYPES,
  isWaypointType,
  positionQuality,
  waypointTypeLabelKey,
  type WaypointPosition,
} from "../field/waypointTypes";
import {
  WAYPOINT_STORAGE_KEY,
  WaypointStore,
  type KeyValueAdapter,
  type PhotoFileAdapter,
} from "../field/waypointStore";
import { WaypointService, type FieldSessionSource } from "../field/waypointService";

// ── Fakes ───────────────────────────────────────────────────────────────────
function fakeStorage(seed: Record<string, string> = {}) {
  const data: Record<string, string> = { ...seed };
  let failWrites = false;
  const adapter: KeyValueAdapter & {
    data: typeof data;
    reads: number;
    failWrites: (v: boolean) => void;
  } = {
    data,
    reads: 0,
    failWrites: (v) => { failWrites = v; },
    async getItem(k) { adapter.reads++; return data[k] ?? null; },
    async setItem(k, v) {
      if (failWrites) throw new Error("disk full");
      data[k] = v;
    },
  };
  return adapter;
}

function fakePhotos() {
  const persisted: { from: string; name: string }[] = [];
  const removed: string[] = [];
  let failOn: string | null = null;
  const adapter: PhotoFileAdapter & {
    persisted: typeof persisted;
    removed: typeof removed;
    failOn: (uri: string | null) => void;
  } = {
    persisted,
    removed,
    failOn: (uri) => { failOn = uri; },
    async persist(sourceUri, fileName) {
      if (sourceUri === failOn) throw new Error("unreadable");
      persisted.push({ from: sourceUri, name: fileName });
      return `file:///app/field/waypoint-photos/${fileName}`;
    },
    async remove(uri) { removed.push(uri); },
  };
  return adapter;
}

const fix = (over: Partial<FieldFix> = {}): FieldFix => ({
  lat: 2.0469,
  lng: 45.3182,
  accuracy: 6,
  altitude: 12,
  speed: null,
  timestamp: 10_000,
  provisional: false,
  ...over,
});

const heading = (over: Partial<FieldHeading> = {}): FieldHeading => ({
  trueHeading: 137,
  magneticHeading: 135,
  accuracy: 3,
  needsCalibration: false,
  ...over,
});

function sessionSource(over: Partial<SessionSnapshot> = {}) {
  const snap: SessionSnapshot = {
    machine: { state: "active", pausedBy: null, errorCode: null },
    sessionId: "fs-1",
    startedAt: 0,
    lastFix: fix(),
    lastHeading: heading(),
    fixCount: 3,
    headingSupported: true,
    degradedAccuracy: false,
    permission: { granted: true, preciseGranted: true, canAskAgain: true },
    ...over,
  };
  const src: FieldSessionSource & { set: (p: Partial<SessionSnapshot>) => void } = {
    getSnapshot: () => snap,
    set: (p) => Object.assign(snap, p),
  };
  return src;
}

function harness(over: Partial<SessionSnapshot> = {}, startAt = 10_500) {
  const storage = fakeStorage();
  const photos = fakePhotos();
  const store = new WaypointStore({ storage, photos });
  const session = sessionSource(over);
  let t = startAt;
  const service = new WaypointService(session, store, () => t);
  return { storage, photos, store, session, service, tick: (ms: number) => { t += ms; }, now: () => t };
}

const pos = (over: Partial<WaypointPosition> = {}): WaypointPosition => ({
  lat: 2, lng: 45, accuracyM: 6, altitudeM: 10, fixedAt: 0, ageMs: 0, provisional: false, ...over,
});

// ── Catalogue ───────────────────────────────────────────────────────────────
describe("waypoint type catalogue", () => {
  test("covers every type the field spec calls for", () => {
    expect([...WAYPOINT_TYPES].sort()).toEqual(
      ["alteration", "contact", "fault", "float", "gossan", "other", "outcrop", "quartz-vein", "sulfides", "vein"],
    );
  });

  test("ids are unique", () => {
    expect(new Set(WAYPOINT_TYPES).size).toBe(WAYPOINT_TYPES.length);
  });

  test("guards unknown ids", () => {
    expect(isWaypointType("gossan")).toBe(true);
    expect(isWaypointType("granite")).toBe(false);
  });

  test("label keys are namespaced for i18n, not raw copy", () => {
    expect(waypointTypeLabelKey("quartz-vein")).toBe("field.waypointType.quartz-vein");
  });
});

// ── Position quality ────────────────────────────────────────────────────────
describe("positionQuality", () => {
  test("no fix is 'none', never a guess", () => {
    expect(positionQuality(null)).toBe("none");
  });

  test("a fresh precise fix is good, at the accuracy limit included", () => {
    expect(positionQuality(pos({ accuracyM: WAYPOINT_DEGRADED_ACCURACY_M }))).toBe("good");
    expect(positionQuality(pos({ accuracyM: WAYPOINT_DEGRADED_ACCURACY_M + 1 }))).toBe("degraded");
  });

  test("a provisional (cached) fix is never reported as good", () => {
    expect(positionQuality(pos({ accuracyM: 3, provisional: true }))).toBe("degraded");
  });

  test("an unknown accuracy is degraded, not assumed good", () => {
    expect(positionQuality(pos({ accuracyM: null }))).toBe("degraded");
  });

  test("age outranks accuracy — a stale fix is stale however precise", () => {
    expect(positionQuality(pos({ accuracyM: 2, ageMs: WAYPOINT_STALE_FIX_MS + 1 }))).toBe("stale");
    expect(positionQuality(pos({ accuracyM: 2, ageMs: WAYPOINT_STALE_FIX_MS }))).toBe("good");
  });
});

// ── Capture ─────────────────────────────────────────────────────────────────
describe("WaypointService.capture", () => {
  test("copies the live snapshot into the record", async () => {
    const { service } = harness();
    const { waypoint, quality } = await service.capture({ type: "gossan", notes: "  boxwork  " });

    expect(waypoint.type).toBe("gossan");
    expect(waypoint.notes).toBe("boxwork");
    expect(waypoint.sessionId).toBe("fs-1");
    expect(waypoint.position).toEqual({
      lat: 2.0469, lng: 45.3182, accuracyM: 6, altitudeM: 12,
      fixedAt: 10_000, ageMs: 500, provisional: false,
    });
    expect(waypoint.heading).toEqual({
      trueHeading: 137, magneticHeading: 135, accuracy: 3,
      needsCalibration: false, sampledAt: 10_500,
    });
    expect(quality).toBe("good");
    expect(waypoint.syncState).toBe("local");
    expect(waypoint.deletedAt).toBeNull();
  });

  test("the recorded position is a copy — a later fix cannot move it", async () => {
    const { service, session } = harness();
    const { waypoint } = await service.capture({ type: "outcrop" });
    session.set({ lastFix: fix({ lat: 9.9, lng: 9.9, timestamp: 99_000 }) });
    expect(service.get(waypoint.id)!.position!.lat).toBe(2.0469);
  });

  test("captures with no fix rather than refusing the observation", async () => {
    const { service } = harness({ lastFix: null, lastHeading: null });
    const { waypoint, quality } = await service.capture({ type: "float" });
    expect(waypoint.position).toBeNull();
    expect(waypoint.heading).toBeNull();
    expect(quality).toBe("none");
    expect(service.list()).toHaveLength(1);
  });

  test("a stale fix is recorded and labelled, not silently trusted", async () => {
    // Last fix 70 s old — past WAYPOINT_STALE_FIX_MS.
    const { service } = harness({ lastFix: fix({ timestamp: 0 }) }, 70_000);
    const { waypoint, quality } = await service.capture({ type: "fault" });
    expect(waypoint.position!.ageMs).toBe(70_000);
    expect(quality).toBe("stale");
  });

  test("blank name normalises to null, notes default to empty", async () => {
    const { service } = harness();
    const { waypoint } = await service.capture({ type: "other", name: "   " });
    expect(waypoint.name).toBeNull();
    expect(waypoint.notes).toBe("");
  });

  test("ids are unique across rapid captures at the same millisecond", async () => {
    const { service } = harness();
    const ids = new Set<string>();
    for (let i = 0; i < 25; i++) ids.add((await service.capture({ type: "vein" })).waypoint.id);
    expect(ids.size).toBe(25);
  });

  test("records the track id when one is supplied", async () => {
    const { service } = harness();
    const { waypoint } = await service.capture({ type: "contact", trackId: "tr-7" });
    expect(waypoint.trackId).toBe("tr-7");
  });
});

// ── Photos ──────────────────────────────────────────────────────────────────
describe("waypoint photos", () => {
  test("photos are copied into app-owned storage, not referenced in place", async () => {
    const { service, photos } = harness();
    const { waypoint } = await service.capture({
      type: "sulfides",
      photoUris: ["file:///tmp/cam1.jpg", "file:///tmp/cam2.jpg"],
    });
    expect(waypoint.photos).toHaveLength(2);
    expect(photos.persisted.map((p) => p.from)).toEqual(["file:///tmp/cam1.jpg", "file:///tmp/cam2.jpg"]);
    expect(waypoint.photos[0].uri).toContain("/field/waypoint-photos/");
    expect(waypoint.photos[0].remotePath).toBeNull();
  });

  test("one unreadable photo does not cost the observation", async () => {
    const { service, photos } = harness();
    photos.failOn("file:///tmp/bad.jpg");
    const res = await service.capture({
      type: "alteration",
      photoUris: ["file:///tmp/ok.jpg", "file:///tmp/bad.jpg"],
    });
    expect(res.waypoint.photos).toHaveLength(1);
    expect(res.photoFailures).toEqual(["file:///tmp/bad.jpg"]);
    expect(service.list()).toHaveLength(1);
  });

  test("photos can be added later", async () => {
    const { service, tick } = harness();
    const { waypoint } = await service.capture({ type: "outcrop" });
    tick(1_000);
    const res = await service.addPhotos(waypoint.id, ["file:///tmp/late.jpg"]);
    expect(res!.waypoint.photos).toHaveLength(1);
    expect(res!.waypoint.updatedAt).toBe(11_500);
  });

  test("adding zero usable photos leaves the record untouched", async () => {
    const { service, photos } = harness();
    const { waypoint } = await service.capture({ type: "outcrop" });
    photos.failOn("file:///tmp/bad.jpg");
    const res = await service.addPhotos(waypoint.id, ["file:///tmp/bad.jpg"]);
    expect(res!.waypoint.photos).toHaveLength(0);
    expect(res!.photoFailures).toEqual(["file:///tmp/bad.jpg"]);
    expect(res!.waypoint.updatedAt).toBe(waypoint.updatedAt);
  });

  test("removing a photo unlinks the file and re-queues the record", async () => {
    const { service, photos } = harness();
    const { waypoint } = await service.capture({ type: "vein", photoUris: ["file:///tmp/a.jpg"] });
    const photoId = waypoint.photos[0].id;
    const res = await service.removePhoto(waypoint.id, photoId);
    expect(res!.waypoint.photos).toHaveLength(0);
    expect(photos.removed).toEqual([waypoint.photos[0].uri]);
  });

  test("removing an unknown photo is a no-op", async () => {
    const { service } = harness();
    const { waypoint } = await service.capture({ type: "vein" });
    expect(await service.removePhoto(waypoint.id, "nope")).toBeNull();
  });
});

// ── Edits and deletes ───────────────────────────────────────────────────────
describe("waypoint edits", () => {
  test("re-classifying keeps the original position and time", async () => {
    const { service, tick } = harness();
    const { waypoint } = await service.capture({ type: "other", notes: "odd rock" });
    tick(5_000);
    const res = await service.update(waypoint.id, { type: "gossan", notes: "  boxwork gossan " });

    expect(res!.waypoint.type).toBe("gossan");
    expect(res!.waypoint.notes).toBe("boxwork gossan");
    expect(res!.waypoint.position).toEqual(waypoint.position);
    expect(res!.waypoint.capturedAt).toBe(waypoint.capturedAt);
    expect(res!.waypoint.updatedAt).toBe(15_500);
  });

  test("an edit re-queues the record for sync", async () => {
    const { service, store } = harness();
    const { waypoint } = await service.capture({ type: "float" });
    await store.put({ ...store.get(waypoint.id)!, syncState: "synced" });
    await service.update(waypoint.id, { notes: "second look" });
    expect(store.get(waypoint.id)!.syncState).toBe("local");
  });

  test("unspecified fields are left alone", async () => {
    const { service } = harness();
    const { waypoint } = await service.capture({ type: "fault", name: "F1", notes: "shear" });
    const res = await service.update(waypoint.id, { type: "contact" });
    expect(res!.waypoint.name).toBe("F1");
    expect(res!.waypoint.notes).toBe("shear");
  });

  test("editing a missing or deleted waypoint returns null", async () => {
    const { service } = harness();
    const { waypoint } = await service.capture({ type: "float" });
    expect(await service.update("nope", { notes: "x" })).toBeNull();
    await service.remove(waypoint.id);
    expect(await service.update(waypoint.id, { notes: "x" })).toBeNull();
  });

  test("delete is soft: hidden from the field list, kept for sync", async () => {
    const { service, store } = harness();
    const { waypoint } = await service.capture({ type: "float" });
    expect(await service.remove(waypoint.id)).toBe(true);
    expect(service.list()).toHaveLength(0);
    expect(store.all()).toHaveLength(1);
    expect(store.get(waypoint.id)!.deletedAt).toBe(10_500);
    expect(await service.remove(waypoint.id)).toBe(false);
  });
});

// ── Listing ─────────────────────────────────────────────────────────────────
describe("waypoint listing", () => {
  test("newest capture first, scoped to the session on request", async () => {
    const { service, session, tick } = harness();
    await service.capture({ type: "outcrop", name: "A" });
    tick(1_000);
    await service.capture({ type: "float", name: "B" });
    session.set({ sessionId: "fs-2" });
    tick(1_000);
    await service.capture({ type: "vein", name: "C" });

    expect(service.list().map((w) => w.name)).toEqual(["C", "B", "A"]);
    expect(service.list("fs-1").map((w) => w.name)).toEqual(["B", "A"]);
    expect(service.listCurrentSession().map((w) => w.name)).toEqual(["C"]);
  });

  test("no running session lists nothing as 'current'", async () => {
    const { service } = harness({ sessionId: null });
    await service.capture({ type: "outcrop" });
    expect(service.listCurrentSession()).toEqual([]);
    expect(service.list()).toHaveLength(1);
  });
});

// ── Persistence ─────────────────────────────────────────────────────────────
describe("WaypointStore persistence", () => {
  test("captures survive a fresh store over the same storage", async () => {
    const storage = fakeStorage();
    const photos = fakePhotos();
    const first = new WaypointStore({ storage, photos });
    const svc = new WaypointService(sessionSource(), first, () => 10_500);
    await svc.capture({ type: "gossan", notes: "ridge" });

    const second = new WaypointStore({ storage, photos });
    await second.load();
    expect(second.visible()).toHaveLength(1);
    expect(second.visible()[0].notes).toBe("ridge");
  });

  test("load() is idempotent and shared across concurrent callers", async () => {
    const storage = fakeStorage();
    const store = new WaypointStore({ storage, photos: fakePhotos() });
    await Promise.all([store.load(), store.load(), store.load()]);
    await store.load();
    expect(storage.reads).toBe(1);
    expect(store.isHydrated()).toBe(true);
  });

  test("corrupt storage starts empty instead of blocking the field screen", async () => {
    const store = new WaypointStore({ storage: fakeStorage({ [WAYPOINT_STORAGE_KEY]: "{not json" }), photos: fakePhotos() });
    await store.load();
    expect(store.isHydrated()).toBe(true);
    expect(store.visible()).toEqual([]);
  });

  test("an unknown envelope version is not adopted and not overwritten on read", async () => {
    const storage = fakeStorage({
      [WAYPOINT_STORAGE_KEY]: JSON.stringify({ version: 99, waypoints: [{ id: "x" }] }),
    });
    const store = new WaypointStore({ storage, photos: fakePhotos() });
    await store.load();
    expect(store.all()).toEqual([]);
    expect(JSON.parse(storage.data[WAYPOINT_STORAGE_KEY]).version).toBe(99);
  });

  test("a failed disk write keeps the observation in memory and flags itself", async () => {
    const { service, store, storage } = harness();
    storage.failWrites(true);
    const { waypoint } = await service.capture({ type: "sulfides" });
    expect(service.list()).toHaveLength(1);
    expect(store.hasPendingWriteFailure()).toBe(true);

    // The next successful mutation rewrites the whole envelope — it self-heals.
    storage.failWrites(false);
    await service.update(waypoint.id, { notes: "retry" });
    expect(store.hasPendingWriteFailure()).toBe(false);
    expect(JSON.parse(storage.data[WAYPOINT_STORAGE_KEY]).waypoints).toHaveLength(1);
  });

  test("everything unsynced is offered to the sync layer, tombstones included", async () => {
    const { service, store } = harness();
    const a = (await service.capture({ type: "outcrop" })).waypoint;
    const b = (await service.capture({ type: "float" })).waypoint;
    await store.put({ ...store.get(a.id)!, syncState: "synced" });
    await service.remove(b.id);
    expect(store.pendingSync().map((w) => w.id)).toEqual([b.id]);
  });

  test("purging synced tombstones deletes their photo files", async () => {
    const { service, store, photos } = harness();
    const { waypoint } = await service.capture({ type: "vein", photoUris: ["file:///tmp/a.jpg"] });
    const localUri = waypoint.photos[0].uri;
    await service.remove(waypoint.id);
    await store.put({ ...store.get(waypoint.id)!, syncState: "synced" });

    expect(await store.purgeSyncedDeletions()).toBe(1);
    expect(store.all()).toHaveLength(0);
    expect(photos.removed).toContain(localUri);
  });

  test("purging leaves unsynced tombstones and live records alone", async () => {
    const { service, store } = harness();
    const live = (await service.capture({ type: "outcrop" })).waypoint;
    const gone = (await service.capture({ type: "float" })).waypoint;
    await service.remove(gone.id);
    expect(await store.purgeSyncedDeletions()).toBe(0);
    expect(store.all().map((w) => w.id).sort()).toEqual([live.id, gone.id].sort());
  });

  test("subscribers are notified on every mutation", async () => {
    const { service, store } = harness();
    let calls = 0;
    const unsub = store.subscribe(() => { calls++; });
    const { waypoint } = await service.capture({ type: "outcrop" });
    const afterCapture = calls;
    expect(afterCapture).toBeGreaterThan(0);
    await service.update(waypoint.id, { notes: "n" });
    expect(calls).toBeGreaterThan(afterCapture);
    unsub();
    const settled = calls;
    await service.remove(waypoint.id);
    expect(calls).toBe(settled);
  });

  test("the stored envelope survives a JSON round trip unchanged", async () => {
    const { service, storage } = harness();
    await service.capture({ type: "quartz-vein", notes: "30cm, boudinaged", photoUris: ["file:///tmp/a.jpg"] });
    const written = storage.data[WAYPOINT_STORAGE_KEY];
    expect(JSON.parse(written)).toEqual(JSON.parse(JSON.stringify(JSON.parse(written))));
    expect(JSON.parse(written).version).toBe(1);
  });
});
