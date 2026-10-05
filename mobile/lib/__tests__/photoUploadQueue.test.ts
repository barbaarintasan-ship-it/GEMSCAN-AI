// Photo upload queue — "no evidence is ever lost".
//
// Field photographs live in a SEPARATE store from the outbox (waypoints), and
// unlike the outbox it had no tests. These lock in the data-loss invariants a
// geologist depends on: a photo survives a dead battery, a killed process, an
// expired URL and a full queue — until R2 confirms it. A non-2xx must NEVER be
// mistaken for a stored photo (a mission analysed against photos that are not
// there is the exact bug this file prevents).
import {
  PhotoUploadQueue,
  PermanentRefusal,
  PHOTO_QUEUE_STORAGE_KEY,
  KEEP_UPLOADED,
  type UploadDeps,
} from "../sync/photoUploadQueue";
import type { KeyValueAdapter } from "../sync/outbox";

function fakeStorage(initial: string | null = null) {
  const store = new Map<string, string>();
  if (initial) store.set(PHOTO_QUEUE_STORAGE_KEY, initial);
  const adapter: KeyValueAdapter = {
    getItem: async (k) => store.get(k) ?? null,
    setItem: async (k, v) => { store.set(k, v); },
  };
  return { adapter, store };
}

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

/** presign that always hands back a URL per photo. */
const okPresign: UploadDeps["presign"] = async (_m, photos) =>
  photos.map((p) => ({ photoId: p.photoId, key: `r2/${p.photoId}`, url: `https://r2/${p.photoId}` }));

/** put with a fixed HTTP status. */
const putStatus = (status: number, bytes?: number): UploadDeps["put"] =>
  async () => ({ status, bytes });

const photo = (id: string) => ({ id, uri: `file:///${id}.jpg`, contentType: "image/jpeg" });

describe("photoUploadQueue — durability", () => {
  test("a queued photo survives a restart (new instance, same storage)", async () => {
    const { adapter, store } = fakeStorage();
    const q1 = new PhotoUploadQueue({ storage: adapter, now: clock().now });
    await q1.enqueue("m1", [photo("p1")]);

    // A fresh instance = the app relaunched after the phone died in a wadi.
    const q2 = new PhotoUploadQueue({ storage: adapter, now: clock().now });
    await q2.load();
    expect(q2.all().map((i) => i.photoId)).toEqual(["p1"]);
    expect(q2.all()[0].state).toBe("pending");
    expect(store.get(PHOTO_QUEUE_STORAGE_KEY)).toContain("p1");
  });

  test("a process killed mid-PUT (state 'uploading') is revived to 'pending' on load, never stranded", async () => {
    const seeded = JSON.stringify([{
      photoId: "p1", missionId: "m1", localUri: "file:///p1.jpg", contentType: "image/jpeg",
      r2Key: "r2/p1", state: "uploading", attempts: 1, lastAttemptAt: 5, lastError: null,
      uploadedAt: null, bytes: null,
    }]);
    const { adapter } = fakeStorage(seeded);
    const q = new PhotoUploadQueue({ storage: adapter, now: clock().now });
    await q.load();
    expect(q.all()[0].state).toBe("pending"); // revived, so it will retry
  });

  test("enqueue is idempotent on photo id — a retried section does not duplicate", async () => {
    const { adapter } = fakeStorage();
    const q = new PhotoUploadQueue({ storage: adapter, now: clock().now });
    await q.enqueue("m1", [photo("p1")]);
    await q.enqueue("m1", [photo("p1"), photo("p2")]);
    expect(q.all().map((i) => i.photoId).sort()).toEqual(["p1", "p2"]);
  });
});

describe("photoUploadQueue — a non-2xx is never success", () => {
  test("an expired URL (403) marks the photo FAILED, not uploaded", async () => {
    const { adapter } = fakeStorage();
    const q = new PhotoUploadQueue({ storage: adapter, now: clock().now });
    await q.enqueue("m1", [photo("p1")]);
    const res = await q.drain({ presign: okPresign, put: putStatus(403), now: clock().now });
    expect(res).toEqual({ uploaded: 0, failed: 1 });
    expect(q.all()[0].state).toBe("failed");
    expect(q.allUploaded("m1")).toBe(false); // gate stays shut — package not analysed
  });

  test("a thrown network error marks FAILED and keeps the photo queued", async () => {
    const { adapter } = fakeStorage();
    const q = new PhotoUploadQueue({ storage: adapter, now: clock().now });
    await q.enqueue("m1", [photo("p1")]);
    const putThrows: UploadDeps["put"] = async () => { throw new Error("network down"); };
    const res = await q.drain({ presign: okPresign, put: putThrows, now: clock().now });
    expect(res.failed).toBe(1);
    expect(q.all()[0].state).toBe("failed");
    expect(q.all()[0].localUri).toBe("file:///p1.jpg"); // still on the phone
  });

  test("a 2xx marks UPLOADED, records the r2 key, and fires onUploaded", async () => {
    const { adapter } = fakeStorage();
    const q = new PhotoUploadQueue({ storage: adapter, now: clock().now });
    await q.enqueue("m1", [photo("p1")]);
    const seen: [string, string][] = [];
    const res = await q.drain({
      presign: okPresign, put: putStatus(200, 12345),
      onUploaded: (id, key) => { seen.push([id, key]); }, now: clock().now,
    });
    expect(res).toEqual({ uploaded: 1, failed: 0 });
    expect(q.all()[0].state).toBe("uploaded");
    expect(q.keyFor("p1")).toBe("r2/p1");
    expect(seen).toEqual([["p1", "r2/p1"]]);
    expect(q.allUploaded("m1")).toBe(true);
  });
});

describe("photoUploadQueue — the bound never drops evidence", () => {
  test("pending photos over KEEP_UPLOADED are ALL kept (never pruned)", async () => {
    const { adapter } = fakeStorage();
    const q = new PhotoUploadQueue({ storage: adapter, now: clock().now });
    const many = Array.from({ length: KEEP_UPLOADED + 10 }, (_, i) => photo(`p${i}`));
    await q.enqueue("m1", many);
    // prune runs on every persist; not one unsent photo may be dropped.
    expect(q.all().length).toBe(KEEP_UPLOADED + 10);
    expect(q.all().every((i) => i.state === "pending")).toBe(true);
  });

  test("a failed photo is never dropped, however full the queue", async () => {
    const { adapter } = fakeStorage();
    const q = new PhotoUploadQueue({ storage: adapter, now: clock().now });
    await q.enqueue("m1", [photo("p1")]);
    await q.drain({ presign: okPresign, put: putStatus(500), now: clock().now });
    expect(q.all().find((i) => i.photoId === "p1")?.state).toBe("failed");
    // fill with uploaded entries beyond the cap; the failed one must remain.
    const more = Array.from({ length: KEEP_UPLOADED + 5 }, (_, i) => photo(`u${i}`));
    await q.enqueue("m1", more);
    await q.drain({ presign: okPresign, put: putStatus(200), now: clock().now });
    expect(q.all().find((i) => i.photoId === "p1")?.state).toBe("failed"); // still there
  });
});

describe("photoUploadQueue — a refusal is kept, not thrown away", () => {
  test("PermanentRefusal blocks the photo (kept + retryable), does not delete it", async () => {
    const { adapter } = fakeStorage();
    const q = new PhotoUploadQueue({ storage: adapter, now: clock().now });
    await q.enqueue("m1", [photo("p1")]);
    const refuse: UploadDeps["presign"] = async () => { throw new PermanentRefusal("not your mission", 403); };
    await q.drain({ presign: refuse, put: putStatus(200), now: clock().now });

    expect(q.all()[0].state).toBe("blocked");
    expect(q.all()[0].localUri).toBe("file:///p1.jpg"); // evidence intact
    expect(q.blockedFor("m1").length).toBe(1);

    // Once the cause is fixed, it goes back in the queue and uploads.
    const n = await q.retryNow("m1");
    expect(n).toBe(1);
    expect(q.all()[0].state).toBe("pending");
    const res = await q.drain({ presign: okPresign, put: putStatus(200), now: clock().now });
    expect(res.uploaded).toBe(1);
    expect(q.allUploaded("m1")).toBe(true);
  });
});
