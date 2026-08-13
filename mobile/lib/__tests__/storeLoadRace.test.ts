// The read that everyone must wait for.
//
// WHAT HAPPENED. A geologist started an expedition. The app was killed — by an
// install, by Android reclaiming memory, by a force-stop. On relaunch the walk was
// gone and the screen offered "Bilow Sahaminta" as though nothing had been
// collected. Four times in a row, reproducibly, while the lease sat on disk the
// whole time.
//
// The cause was four characters in the wrong place:
//
//     if (this.loaded) return;
//     this.loaded = true;          // ← BEFORE the await
//     const raw = await this.storage.getItem(KEY);
//
// The second caller in a tick saw `loaded === true` and returned from a read that
// had not happened yet, with the collection still empty. In the app the route's
// lease hook always won that race and the exploration provider always lost, which
// is why it looked deterministic rather than flaky.
//
// FIVE STORES HAD THIS SHAPE, and in three of them it is worse than a lost lease.
// `enqueue()` awaits `load()` and then persists the whole collection — so a
// waypoint recorded inside that window would have written ONE entry over every
// unsent record on disk. Field records, gone, silently. That path is asserted
// below, because "nothing collected in the field is ever lost" is the first
// clause of the contract and it was reachable.
import { ExpeditionLeaseStore, LEASE_STORAGE_KEY } from "../exploration/expeditionLease";
import { Outbox, OUTBOX_STORAGE_KEY, type OutboxEntry } from "../sync/outbox";
import { RoadFactorStore, ROAD_FACTOR_STORAGE_KEY } from "../geo/roadFactor";
import { LocalSampleStore, LOCAL_SAMPLE_STORAGE_KEY } from "../samples/localSampleStore";
import { ExpeditionRecorder, EXPEDITION_STORAGE_KEY } from "../field/expeditionRecorder";
import type { KeyValueAdapter } from "../samples/localSampleStore";

const NOW = 1_800_000_000_000;

/**
 * Storage whose reads take several microtasks, like a real bridge call.
 *
 * The delay is what makes the race observable. With no delay every store passes,
 * which is precisely why this shipped.
 */
function slowStorage(seed: Record<string, string> = {}, ticks = 4) {
  const map = new Map(Object.entries(seed));
  const adapter: KeyValueAdapter = {
    getItem: async (k) => {
      for (let i = 0; i < ticks; i++) await Promise.resolve();
      return map.get(k) ?? null;
    },
    setItem: async (k, v) => { map.set(k, v); },
  };
  return { adapter, map };
}

/**
 * What the SECOND caller sees at the moment its `load()` resolves.
 *
 * Not what it sees eventually — eventually everything is loaded and the bug is
 * invisible. The failure is that the second caller was told the read was done.
 */
async function secondCallerSees<T>(load: () => Promise<void>, read: () => T): Promise<T> {
  let seen!: T;
  const first = load();
  const second = load().then(() => { seen = read(); });
  await Promise.all([first, second]);
  return seen;
}

describe("every store makes concurrent callers wait for the real read", () => {
  test("the lease — this is the expedition that vanished", async () => {
    const lease = JSON.stringify({
      version: 1,
      lease: {
        expeditionId: "ex-karkaar", openedAt: NOW - 3_600_000,
        collectedBy: null, build: "1.11.3 (89)", state: "attached", detachedAt: null,
      },
    });
    const store = new ExpeditionLeaseStore({
      storage: slowStorage({ [LEASE_STORAGE_KEY]: lease }).adapter,
      now: () => NOW,
    });

    const seen = await secondCallerSees(() => store.load(), () => store.get());
    // The exploration provider is the second caller in the real app. This value
    // being null is exactly "the walk is gone".
    expect(seen?.expeditionId).toBe("ex-karkaar");
    expect(store.isOpen()).toBe(true);
  });

  test("the outbox", async () => {
    const held = JSON.stringify({
      version: 1,
      entries: [entry("a"), entry("b")],
    });
    const outbox = new Outbox({
      storage: slowStorage({ [OUTBOX_STORAGE_KEY]: held }).adapter,
      now: () => NOW,
    });
    const seen = await secondCallerSees(() => outbox.load(), () => outbox.stats().stored);
    expect(seen).toBe(2);
  });

  test("the local sample store", async () => {
    const held = JSON.stringify({
      version: 1,
      samples: [{ localId: "s1" }, { localId: "s2" }],
    });
    const store = new LocalSampleStore({
      storage: slowStorage({ [LOCAL_SAMPLE_STORAGE_KEY]: held }).adapter,
    });
    const seen = await secondCallerSees(() => store.load(), () => store.all().length);
    expect(seen).toBe(2);
  });

  test("the measured road factor", async () => {
    const held = JSON.stringify({
      version: 1,
      measurements: [{ factor: 2.4, displacementM: 70_000, at: NOW, returned: true }],
    });
    const store = new RoadFactorStore({
      storage: slowStorage({ [ROAD_FACTOR_STORAGE_KEY]: held }).adapter,
    });
    const seen = await secondCallerSees(() => store.load(), () => store.isMeasured());
    // False here means the device silently forgets what it measured on the ground.
    expect(seen).toBe(true);
  });

  test("the expedition recorder keeps the walk's original clock", async () => {
    // A recorder that lost its history does not find the open expedition, so it
    // writes a NEW record under the same id with `startedAt = now` — and the walk
    // forgets how long the geologist has been out. That is the number they plan
    // water and daylight around.
    const startedAt = NOW - 5 * 3_600_000;   // out for five hours
    const held = JSON.stringify({
      version: 1,
      expeditions: [{
        sessionId: "ex-1", startedAt, endedAt: null, status: "active",
        distanceM: 41_000, movingMs: 4 * 3_600_000, observationCount: 6,
      }],
    });
    const st = slowStorage({ [EXPEDITION_STORAGE_KEY]: held });
    const rec = new ExpeditionRecorder({
      outbox: new Outbox({ storage: slowStorage().adapter, now: () => NOW }),
      storage: st.adapter,
      now: () => NOW,
    });

    const reading = rec.load();
    const reopened = await rec.open("ex-1");
    await reading;

    expect(reopened.startedAt).toBe(startedAt);
    expect(reopened.distanceM).toBe(41_000);
  });
});

describe("a write during the read does not overwrite what is on disk", () => {
  // THE BYTE-LOSS PATH. `enqueue()` awaits `load()` and then persists the whole
  // collection. When `load()` returned early from an unfinished read, the write
  // that followed replaced two held records with one.
  test("a waypoint queued mid-read joins the queue instead of replacing it", async () => {
    const held = JSON.stringify({ version: 1, entries: [entry("a"), entry("b")] });
    const st = slowStorage({ [OUTBOX_STORAGE_KEY]: held });
    const outbox = new Outbox({ storage: st.adapter, now: () => NOW });

    // The read starts, and a record arrives before it lands — a geologist marking
    // an outcrop within a second of the app launching.
    const reading = outbox.load();
    await outbox.enqueue("observation", "ex-1", "c", { note: "quartz vein" });
    await reading;

    expect(outbox.stats().stored).toBe(3);
    const onDisk = JSON.parse(st.map.get(OUTBOX_STORAGE_KEY)!) as { entries: OutboxEntry[] };
    expect(onDisk.entries.map((e) => e.localId).sort()).toEqual(["a", "b", "c"]);
  });
});

function entry(localId: string): OutboxEntry {
  return {
    localId, kind: "observation", sessionId: "ex-1", payload: {},
    queuedAt: NOW, sentAt: null, attempts: 0, lastAttemptAt: null, lastError: null,
  };
}
