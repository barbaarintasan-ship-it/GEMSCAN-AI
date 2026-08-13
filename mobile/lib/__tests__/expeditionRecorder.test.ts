// The expedition lifecycle — automatic, and never lossy.
//
// Architecture v2 §6: the user never manages an expedition. That puts the whole
// burden on this module getting the edges right — a remount must not fork the
// walk in two, a crash must not abandon it, and a retry must not duplicate a pin.
import {
  ExpeditionRecorder, EXPEDITION_STORAGE_KEY, TRACK_SNAPSHOT_EVERY_M,
  TRACK_SNAPSHOT_EVERY_MS, type KeyValueAdapter,
} from "../field/expeditionRecorder";
import { Outbox } from "../sync/outbox";
import type { Waypoint } from "../field/waypointTypes";

function storage(initial?: string) {
  const store = new Map<string, string>();
  if (initial) store.set(EXPEDITION_STORAGE_KEY, initial);
  const adapter: KeyValueAdapter = {
    getItem: async (k) => store.get(k) ?? null,
    setItem: async (k, v) => { store.set(k, v); },
  };
  return { adapter, store };
}

function clock(start = 1_700_000_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

function setup(initial?: string) {
  const c = clock();
  const box = new Outbox({ storage: storage().adapter, now: c.now });
  const s = storage(initial);
  const rec = new ExpeditionRecorder({ outbox: box, storage: s.adapter, now: c.now });
  return { rec, box, c, store: s.store };
}

const waypoint = (over: Partial<Waypoint> = {}): Waypoint => ({
  id: "wp-1",
  sessionId: "ex-1",
  trackId: null,
  type: "quartz-vein",
  name: null,
  notes: "milky quartz, boxwork",
  position: {
    lat: 9.5, lng: 49.0, accuracyM: 4.7, altitudeM: 640,
    fixedAt: 1_700_000_000_000, ageMs: 900, provisional: false,
  },
  heading: null,
  photos: [],
  capturedAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  syncState: "local",
  deletedAt: null,
  ...over,
});

const kinds = (box: Outbox) => box.all().map((e) => e.kind);

describe("opening", () => {
  test("starting a session opens exactly one expedition and queues it", async () => {
    const { rec, box } = setup();
    await rec.open("ex-1");
    expect(rec.current()?.sessionId).toBe("ex-1");
    expect(kinds(box)).toEqual(["expedition.open"]);
  });

  test("a remount does not fork the walk in two", async () => {
    const { rec, box } = setup();
    await rec.open("ex-1");
    await rec.open("ex-1");
    await rec.open("ex-1");
    expect(rec.all()).toHaveLength(1);
    expect(box.all().filter((e) => e.kind === "expedition.open")).toHaveLength(1);
  });

  test("an expedition left active by a crash is closed, not abandoned", async () => {
    const first = setup();
    await first.rec.open("ex-1");
    // The app dies here: "ex-1" is still marked active on disk.

    const second = setup(first.store.get(EXPEDITION_STORAGE_KEY));
    await second.rec.open("ex-2");

    const recovered = second.rec.all().find((e) => e.sessionId === "ex-1");
    expect(recovered?.status).toBe("closed");
    expect(second.rec.current()?.sessionId).toBe("ex-2");
    // And the server is told about the recovered one rather than never hearing.
    const closes = second.box.all().filter((e) => e.kind === "expedition.close");
    expect(closes.map((e) => e.sessionId)).toEqual(["ex-1"]);
    expect((closes[0].payload as { closed_by: string }).closed_by).toBe("recovered");
  });
});

describe("closing", () => {
  test("the final stats come from the recorder, not recomputed", async () => {
    const { rec, box, c } = setup();
    await rec.open("ex-1");
    c.advance(3_600_000);
    await rec.close("ex-1", { distanceM: 7421.6, movingMs: 2_700_000 });

    const close = box.all().find((e) => e.kind === "expedition.close");
    expect(close).toBeDefined();
    expect(close!.payload).toMatchObject({
      device_session_id: "ex-1",
      distance_m: 7422,
      moving_ms: 2_700_000,
      closed_by: "ended",
    });
    expect(rec.current()).toBeNull();
  });

  test("closing twice queues one close", async () => {
    const { rec, box } = setup();
    await rec.open("ex-1");
    await rec.close("ex-1", { distanceM: 10, movingMs: 10 });
    await rec.close("ex-1", { distanceM: 10, movingMs: 10 });
    expect(box.all().filter((e) => e.kind === "expedition.close")).toHaveLength(1);
  });

  test("closing an unknown session does nothing rather than inventing one", async () => {
    const { rec, box } = setup();
    await rec.close("never-existed");
    expect(box.all()).toEqual([]);
  });
});

describe("observations", () => {
  test("a waypoint is queued with its accuracy unrounded", async () => {
    const { rec, box } = setup();
    await rec.open("ex-1");
    await rec.recordObservation("ex-1", waypoint());

    const entry = box.all().find((e) => e.kind === "observation");
    expect(entry!.localId).toBe("wp-1");
    expect(entry!.payload).toMatchObject({
      object_type: "quartz-vein",
      lat: 9.5, lng: 49.0,
      gps_accuracy_m: 4.7,      // NOT 5
      provisional: false,
    });
  });

  test("an edited waypoint is one row in its final state", async () => {
    const { rec, box } = setup();
    await rec.open("ex-1");
    await rec.recordObservation("ex-1", waypoint({ notes: "first" }));
    await rec.recordObservation("ex-1", waypoint({ notes: "corrected" }));

    const obs = box.all().filter((e) => e.kind === "observation");
    expect(obs).toHaveLength(1);
    expect(obs[0].payload).toMatchObject({ notes: "corrected" });
  });

  test("a deletion is queued too — one the server never hears about comes back", async () => {
    const { rec, box } = setup();
    await rec.open("ex-1");
    await rec.recordObservation("ex-1", waypoint({ deletedAt: 1_700_000_100_000 }));
    const entry = box.all().find((e) => e.kind === "observation");
    expect((entry!.payload as { deleted_at: string | null }).deleted_at).not.toBeNull();
  });

  test("a waypoint with no fix still records — it just has no coordinates", async () => {
    const { rec, box } = setup();
    await rec.open("ex-1");
    await rec.recordObservation("ex-1", waypoint({ position: null }));
    expect(box.all().find((e) => e.kind === "observation")!.payload).toMatchObject({
      lat: null, lng: null, gps_accuracy_m: null,
    });
  });
});

describe("the traverse", () => {
  const line = (n: number): Array<[number, number]> =>
    Array.from({ length: n }, (_, i) => [49 + i * 1e-4, 9.5] as [number, number]);

  test("a line needs two points to be a line", async () => {
    const { rec } = setup();
    await rec.open("ex-1");
    expect(await rec.recordTrack("ex-1", line(1), { distanceM: 0, movingMs: 0 })).toBe(false);
  });

  test("it is snapshotted once the walk has covered ground", async () => {
    const { rec, box } = setup();
    await rec.open("ex-1");
    // Not yet: a few metres is not worth a write.
    expect(await rec.recordTrack("ex-1", line(5), { distanceM: 40, movingMs: 30_000 })).toBe(false);
    expect(
      await rec.recordTrack("ex-1", line(60), { distanceM: TRACK_SNAPSHOT_EVERY_M + 1, movingMs: 60_000 }),
    ).toBe(true);
    expect(box.all().filter((e) => e.kind === "track")).toHaveLength(1);
  });

  test("standing at one outcrop for an hour still records the line", async () => {
    const { rec, c } = setup();
    await rec.open("ex-1");
    await rec.recordTrack("ex-1", line(10), { distanceM: 300, movingMs: 60_000 });
    c.advance(TRACK_SNAPSHOT_EVERY_MS + 1);
    expect(await rec.recordTrack("ex-1", line(12), { distanceM: 305, movingMs: 61_000 })).toBe(true);
  });

  test("the growing traverse is ONE queue entry, not one per snapshot", async () => {
    const { rec, box } = setup();
    await rec.open("ex-1");
    for (let i = 1; i <= 5; i++) {
      await rec.recordTrack(
        "ex-1", line(20 * i),
        { distanceM: TRACK_SNAPSHOT_EVERY_M * i + 1, movingMs: 60_000 * i },
      );
    }
    const tracks = box.all().filter((e) => e.kind === "track");
    expect(tracks).toHaveLength(1);
    expect((tracks[0].payload as { point_count: number }).point_count).toBe(100);
  });

  test("points travel in GeoJSON axis order, so nothing has to be flipped", async () => {
    const { rec, box } = setup();
    await rec.open("ex-1");
    await rec.recordTrack("ex-1", line(5), { distanceM: 999, movingMs: 1000 }, { force: true });
    const p = (box.all().find((e) => e.kind === "track")!.payload as { points: number[][] }).points;
    expect(p[0][0]).toBeCloseTo(49, 3);    // lng first
    expect(p[0][1]).toBeCloseTo(9.5, 3);   // lat second
  });
});

describe("persistence", () => {
  test("the expedition survives a restart and is still the current one", async () => {
    const first = setup();
    await first.rec.open("ex-1");
    await first.rec.recordObservation("ex-1", waypoint());

    const second = setup(first.store.get(EXPEDITION_STORAGE_KEY));
    await second.rec.load();
    expect(second.rec.current()?.sessionId).toBe("ex-1");
    expect(second.rec.current()?.observationCount).toBe(1);
  });

  test("an unreadable store does not stop the next walk", async () => {
    const { rec } = setup("{broken");
    await rec.open("ex-9");
    expect(rec.current()?.sessionId).toBe("ex-9");
  });
});
