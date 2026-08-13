// The photo upload queue: LOCAL_PENDING_UPLOAD → UPLOADING → UPLOADED.
//
// The rule these tests exist for is "ha lumin wax evidence ah" — lose no
// evidence. A geologist on a mountain with no signal photographs a vein, and that
// photograph must survive no network, a bad URL, a killed process, and a server
// that lies about success. Every case below is one of those.
import { PermanentRefusal, PhotoUploadQueue, PHOTO_QUEUE_STORAGE_KEY, type UploadDeps } from "../sync/photoUploadQueue";
import { RETRY_BASE_MS, type KeyValueAdapter } from "../sync/outbox";

const NOW = Date.parse("2026-08-10T00:00:00.000Z");

function memoryStorage(): KeyValueAdapter & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: async (k) => data.get(k) ?? null,
    setItem: async (k, v) => { data.set(k, v); },
  };
}

/** A server that signs whatever it is asked for, and an R2 that accepts it. */
function happyDeps(over: Partial<UploadDeps> = {}, at = () => NOW): UploadDeps {
  return {
    presign: async (missionId, photos) =>
      photos.map((p) => ({
        photoId: p.photoId,
        key: `missions/${missionId}/photos/${p.photoId}.jpg`,
        url: `https://acct.r2.cloudflarestorage.com/b/missions/${missionId}/photos/${p.photoId}.jpg?X-Amz-Signature=x`,
      })),
    put: async () => ({ status: 200, bytes: 2_400_000 }),
    now: at,
    ...over,
  };
}

const PHOTOS = [
  { id: "p1", uri: "file:///photos/p1.jpg" },
  { id: "p2", uri: "file:///photos/p2.jpg" },
];

describe("the happy path", () => {
  test("photos are presigned in one call per mission and uploaded", async () => {
    const q = new PhotoUploadQueue({ storage: memoryStorage(), now: () => NOW });
    await q.enqueue("ms-abc", PHOTOS);

    let presignCalls = 0;
    const result = await q.drain(happyDeps({
      presign: async (missionId, photos) => {
        presignCalls++;
        return photos.map((p) => ({
          photoId: p.photoId, key: `missions/${missionId}/photos/${p.photoId}.jpg`, url: "https://r2/x",
        }));
      },
    }));

    expect(result).toEqual({ uploaded: 2, failed: 0 });
    // One round trip for the mission, not one per file: this runs on a cellular
    // link where every request is a chance to fail.
    expect(presignCalls).toBe(1);
    expect(q.allUploaded("ms-abc")).toBe(true);
    expect(q.keyFor("p1")).toBe("missions/ms-abc/photos/p1.jpg");
  });

  test("enqueueing is idempotent, so a retried section re-uploads nothing", async () => {
    const q = new PhotoUploadQueue({ storage: memoryStorage(), now: () => NOW });
    await q.enqueue("ms-abc", PHOTOS);
    await q.drain(happyDeps());
    await q.enqueue("ms-abc", PHOTOS);

    let puts = 0;
    await q.drain(happyDeps({ put: async () => { puts++; return { status: 200 }; } }));
    expect(puts).toBe(0);
    expect(q.all().length).toBe(2);
  });

  test("a mission with no photographs is already complete", () => {
    // "I went there and there was nothing to photograph" is a real finding, and it
    // must not wait for ever on files that were never taken.
    const q = new PhotoUploadQueue({ storage: memoryStorage(), now: () => NOW });
    expect(q.allUploaded("ms-empty")).toBe(true);
  });
});

describe("nothing is lost when the network is not there", () => {
  test("a presign failure leaves everything queued, not dropped", async () => {
    const q = new PhotoUploadQueue({ storage: memoryStorage(), now: () => NOW });
    await q.enqueue("ms-abc", PHOTOS);

    const result = await q.drain(happyDeps({
      presign: async () => { throw new Error("no network"); },
    }));
    expect(result).toEqual({ uploaded: 0, failed: 2 });
    expect(q.pendingFor("ms-abc")).toHaveLength(2);
    expect(q.all()[0].state).toBe("failed");
    expect(q.all()[0].lastError).toBe("no network");
    expect(q.allUploaded("ms-abc")).toBe(false);
  });

  test("and it uploads later, when the network comes back", async () => {
    const storage = memoryStorage();
    let at = NOW;
    const q = new PhotoUploadQueue({ storage, now: () => at });
    await q.enqueue("ms-abc", PHOTOS);
    await q.drain(happyDeps({ presign: async () => { throw new Error("no network"); } }, () => at));

    // Backoff: nothing is due immediately after a failure.
    expect(q.due(at)).toHaveLength(0);
    at = NOW + RETRY_BASE_MS * 8;
    expect(q.due(at).length).toBeGreaterThan(0);

    const result = await q.drain(happyDeps({}, () => at));
    expect(result.uploaded).toBe(2);
    expect(q.allUploaded("ms-abc")).toBe(true);
  });

  test("a failed entry is retried for ever and never discarded", async () => {
    const storage = memoryStorage();
    let at = NOW;
    const q = new PhotoUploadQueue({ storage, now: () => at });
    await q.enqueue("ms-abc", [PHOTOS[0]]);
    for (let i = 0; i < 12; i++) {
      await q.drain(happyDeps({ put: async () => ({ status: 500 }) }, () => at));
      at += 24 * 60 * 60 * 1000;
    }
    // Twelve days of failure, and the evidence is still on the queue.
    expect(q.all()).toHaveLength(1);
    expect(q.pendingFor("ms-abc")).toHaveLength(1);
    expect(q.stats(at).failing).toBe(1);
    // And it still succeeds when the cause is fixed.
    expect((await q.drain(happyDeps({}, () => at))).uploaded).toBe(1);
  });
});

describe("a server saying yes is not the same as bytes arriving", () => {
  test("a non-2xx is a FAILURE, and nothing is marked uploaded", async () => {
    const q = new PhotoUploadQueue({ storage: memoryStorage(), now: () => NOW });
    await q.enqueue("ms-abc", [PHOTOS[0]]);
    // 403 is what an expired presigned URL returns. Treating it as success would
    // mean a mission analysed against a photograph that was never stored.
    const result = await q.drain(happyDeps({ put: async () => ({ status: 403 }) }));
    expect(result).toEqual({ uploaded: 0, failed: 1 });
    expect(q.all()[0].state).toBe("failed");
    expect(q.all()[0].lastError).toBe("R2 returned 403");
    expect(q.all()[0].uploadedAt).toBeNull();
    expect(q.allUploaded("ms-abc")).toBe(false);
  });

  test("a photo the server would not sign is failed, not silently skipped", async () => {
    const q = new PhotoUploadQueue({ storage: memoryStorage(), now: () => NOW });
    await q.enqueue("ms-abc", PHOTOS);
    // Only p1 comes back signed.
    const result = await q.drain(happyDeps({
      presign: async (missionId, photos) => photos
        .filter((p) => p.photoId === "p1")
        .map((p) => ({ photoId: p.photoId, key: `missions/${missionId}/photos/${p.photoId}.jpg`, url: "https://r2/x" })),
    }));
    expect(result).toEqual({ uploaded: 1, failed: 1 });
    const p2 = q.all().find((x) => x.photoId === "p2")!;
    expect(p2.state).toBe("failed");
    expect(p2.lastError).toBe("server returned no URL for this photo");
  });

  test("a thrown PUT is a failure like any other", async () => {
    const q = new PhotoUploadQueue({ storage: memoryStorage(), now: () => NOW });
    await q.enqueue("ms-abc", [PHOTOS[0]]);
    await q.drain(happyDeps({ put: async () => { throw new Error("socket closed"); } }));
    expect(q.all()[0].state).toBe("failed");
    expect(q.all()[0].lastError).toBe("socket closed");
  });
});

describe("surviving the process being killed", () => {
  test("state is on disk before the PUT, so a death mid-upload is visible", async () => {
    const storage = memoryStorage();
    const q = new PhotoUploadQueue({ storage, now: () => NOW });
    await q.enqueue("ms-abc", [PHOTOS[0]]);

    // Die inside the PUT, after the queue has already written "uploading".
    await q.drain(happyDeps({
      put: async () => {
        const onDisk = JSON.parse(storage.data.get(PHOTO_QUEUE_STORAGE_KEY)!);
        expect(onDisk[0].state).toBe("uploading");
        expect(onDisk[0].r2Key).toBe("missions/ms-abc/photos/p1.jpg");
        throw new Error("process killed");
      },
    }));

    // A fresh queue over the same bytes revives it rather than leaving a
    // photograph that never retries and never uploads.
    const reopened = new PhotoUploadQueue({ storage, now: () => NOW });
    await reopened.load();
    expect(reopened.all()[0].state).not.toBe("uploading");
    expect(reopened.pendingFor("ms-abc")).toHaveLength(1);
  });

  test("an entry left as 'uploading' on disk is revived on load", async () => {
    const storage = memoryStorage();
    // Exactly what the store looks like after a kill between the write and the PUT.
    storage.data.set(PHOTO_QUEUE_STORAGE_KEY, JSON.stringify([{
      photoId: "p1", missionId: "ms-abc", localUri: "file:///photos/p1.jpg",
      contentType: "image/jpeg", r2Key: "missions/ms-abc/photos/p1.jpg",
      state: "uploading", attempts: 1, lastAttemptAt: NOW - 100_000,
      lastError: null, uploadedAt: null, bytes: null,
    }]));
    const q = new PhotoUploadQueue({ storage, now: () => NOW });
    await q.load();
    expect(q.all()[0].state).toBe("pending");
    expect(q.due(NOW).length).toBe(1);
  });

  test("uploaded entries are NOT re-uploaded after a restart", async () => {
    const storage = memoryStorage();
    const q = new PhotoUploadQueue({ storage, now: () => NOW });
    await q.enqueue("ms-abc", PHOTOS);
    await q.drain(happyDeps());

    const reopened = new PhotoUploadQueue({ storage, now: () => NOW });
    await reopened.load();
    let puts = 0;
    await reopened.drain(happyDeps({ put: async () => { puts++; return { status: 200 }; } }));
    expect(puts).toBe(0);
    expect(reopened.allUploaded("ms-abc")).toBe(true);
  });
});

describe("the gate on analysis", () => {
  test("allUploaded is false until every photograph is confirmed", async () => {
    const q = new PhotoUploadQueue({ storage: memoryStorage(), now: () => NOW });
    await q.enqueue("ms-abc", PHOTOS);
    expect(q.allUploaded("ms-abc")).toBe(false);

    await q.drain(happyDeps({
      put: async (url) => ({ status: url.includes("p1") ? 200 : 500 }),
      presign: async (missionId, photos) => photos.map((p) => ({
        photoId: p.photoId,
        key: `missions/${missionId}/photos/${p.photoId}.jpg`,
        url: `https://r2/${p.photoId}`,
      })),
    }));
    // One of two arrived. A package analysed now would be assessed against half
    // the evidence and would read exactly like a complete one.
    expect(q.allUploaded("ms-abc")).toBe(false);
    expect(q.stats(NOW).uploaded).toBe(1);
  });

  test("missions are independent — one mission's failure does not hold another", async () => {
    const q = new PhotoUploadQueue({ storage: memoryStorage(), now: () => NOW });
    await q.enqueue("ms-one", [PHOTOS[0]]);
    await q.enqueue("ms-two", [{ id: "p9", uri: "file:///photos/p9.jpg" }]);
    await q.drain(happyDeps({
      presign: async (missionId, photos) => {
        if (missionId === "ms-one") throw new Error("no network");
        return photos.map((p) => ({
          photoId: p.photoId, key: `missions/${missionId}/photos/${p.photoId}.jpg`, url: "https://r2/x",
        }));
      },
    }));
    expect(q.allUploaded("ms-one")).toBe(false);
    expect(q.allUploaded("ms-two")).toBe(true);
  });
});

describe("concurrency", () => {
  test("two drains at once do not upload the same file twice", async () => {
    const q = new PhotoUploadQueue({ storage: memoryStorage(), now: () => NOW });
    await q.enqueue("ms-abc", PHOTOS);
    let puts = 0;
    const deps = happyDeps({
      put: async () => { puts++; await new Promise((r) => setTimeout(r, 5)); return { status: 200 }; },
    });
    await Promise.all([q.drain(deps), q.drain(deps)]);
    expect(puts).toBe(2);
    expect(q.allUploaded("ms-abc")).toBe(true);
  });
});

// ── The store is read into memory on every launch, so it must be bounded ─────
//
// It was not, when first written. A season of field work is thousands of
// photographs, and an unbounded JSON file parsed at startup is the exact mistake
// that once took this app from 297 MB to 588 MB.
describe("bounded growth, without ever losing evidence", () => {
  const KEEP = 200;

  async function withUploaded(n: number) {
    const storage = memoryStorage();
    let at = NOW;
    const q = new PhotoUploadQueue({ storage, now: () => at });
    for (let i = 0; i < n; i++) {
      at = NOW + i * 1000;
      await q.enqueue("ms-abc", [{ id: `p${i}`, uri: `file:///photos/p${i}.jpg` }]);
      await q.drain(happyDeps({}, () => at));
    }
    return { q, storage, at };
  }

  test("uploaded entries are pruned to the bound", async () => {
    const { q } = await withUploaded(KEEP + 40);
    expect(q.all().length).toBe(KEEP);
    // The oldest went; the newest stayed.
    expect(q.all().some((i) => i.photoId === "p0")).toBe(false);
    expect(q.all().some((i) => i.photoId === `p${KEEP + 39}`)).toBe(true);
  });

  test("THE INVARIANT: an entry that has not reached R2 is never dropped", async () => {
    const storage = memoryStorage();
    let at = NOW;
    const q = new PhotoUploadQueue({ storage, now: () => at });

    // One photograph that will never upload — a geologist's evidence, still on the
    // phone. It fails on EVERY attempt, including the retries the later drains
    // pick up, which is the situation being guarded against.
    const failsOnlyPrecious: Partial<UploadDeps> = {
      put: async (url) => ({ status: url.includes("precious") ? 500 : 200, bytes: 2_400_000 }),
    };
    await q.enqueue("ms-lost", [{ id: "precious", uri: "file:///photos/precious.jpg" }]);

    // Then a season's worth of successful ones on top of it.
    for (let i = 0; i < KEEP + 100; i++) {
      at = NOW + (i + 1) * 60_000;
      await q.enqueue("ms-abc", [{ id: `p${i}`, uri: `file:///photos/p${i}.jpg` }]);
      await q.drain(happyDeps(failsOnlyPrecious, () => at));
    }

    // The bound is exceeded by exactly the un-uploaded one, deliberately: if the
    // bound and the evidence ever conflict, the bound loses.
    expect(q.all().length).toBe(KEEP + 1);
    const precious = q.all().find((i) => i.photoId === "precious");
    expect(precious).toBeDefined();
    expect(precious!.state).not.toBe("uploaded");
    expect(q.allUploaded("ms-lost")).toBe(false);
  });

  test("the file on disk stops growing", async () => {
    const a = await withUploaded(KEEP);
    const sizeAt200 = a.storage.data.get(PHOTO_QUEUE_STORAGE_KEY)!.length;
    const b = await withUploaded(KEEP + 200);
    const sizeAt400 = b.storage.data.get(PHOTO_QUEUE_STORAGE_KEY)!.length;
    // Twice the photographs, the same file size — within the slack of longer ids.
    expect(sizeAt400).toBeLessThan(sizeAt200 * 1.2);
  });
});

describe("a REFUSAL is not a failure", () => {
  // The gate on r2-presign made this reachable: an account that is not enabled
  // gets 403, and 403 will still be 403 in fifteen minutes. A queue that keeps
  // asking flattens a field phone's battery over days for an answer that cannot
  // move — while a genuine outage must keep being retried for ever, because the
  // photograph is evidence and evidence is never dropped.
  function refusing(status = 403): UploadDeps {
    return happyDeps({
      presign: async () => { throw new PermanentRefusal("not enabled", status); },
    });
  }

  test("a refused batch is BLOCKED, and stops being due", async () => {
    const q = new PhotoUploadQueue({ storage: memoryStorage(), now: () => NOW });
    await q.enqueue("ms-abc", PHOTOS);
    await q.drain(refusing());

    expect(q.stats(NOW).blocked).toBe(2);
    // Not due now, and not due after any amount of waiting.
    expect(q.due(NOW).length).toBe(0);
    expect(q.due(NOW + 86_400_000).length).toBe(0);
  });

  test("a refusal never asks again — a second drain presigns nothing", async () => {
    const q = new PhotoUploadQueue({ storage: memoryStorage(), now: () => NOW });
    await q.enqueue("ms-abc", PHOTOS);
    await q.drain(refusing());

    let calls = 0;
    await q.drain(happyDeps({
      presign: async () => { calls++; return []; },
    }, () => NOW + 86_400_000));
    expect(calls).toBe(0);
  });

  test("the photographs are KEPT — a refusal loses no evidence", async () => {
    const q = new PhotoUploadQueue({ storage: memoryStorage(), now: () => NOW });
    await q.enqueue("ms-abc", PHOTOS);
    await q.drain(refusing());

    const blocked = q.blockedFor("ms-abc");
    expect(blocked.map((b) => b.photoId).sort()).toEqual(["p1", "p2"]);
    expect(blocked[0].localUri).toBe("file:///photos/p1.jpg");
    expect(blocked[0].lastError).toContain("not enabled");
  });

  test("the mission is still not ready for analysis", async () => {
    // Blocked is not uploaded. A package must never be assessed against
    // photographs the server refused to store.
    const q = new PhotoUploadQueue({ storage: memoryStorage(), now: () => NOW });
    await q.enqueue("ms-abc", PHOTOS);
    await q.drain(refusing());
    expect(q.allUploaded("ms-abc")).toBe(false);
  });

  test("retryBlocked puts them back, immediately", async () => {
    const q = new PhotoUploadQueue({ storage: memoryStorage(), now: () => NOW });
    await q.enqueue("ms-abc", PHOTOS);
    await q.drain(refusing());

    expect(await q.retryBlocked("ms-abc")).toBe(2);
    // No backoff to wait out: the person just fixed the thing that caused it.
    expect(q.due(NOW).length).toBe(2);

    const r = await q.drain(happyDeps());
    expect(r.uploaded).toBe(2);
  });

  test("an ORDINARY failure still retries for ever", async () => {
    // The distinction this whole state exists for. No signal is not a refusal.
    const q = new PhotoUploadQueue({ storage: memoryStorage(), now: () => NOW });
    await q.enqueue("ms-abc", PHOTOS);
    await q.drain(happyDeps({
      presign: async () => { throw new Error("Network request failed"); },
    }));

    expect(q.stats(NOW).blocked).toBe(0);
    expect(q.due(NOW + RETRY_BASE_MS * 100).length).toBe(2);
  });
});

describe("the observation learns where its photograph went", () => {
  // `remotePath` was declared on the waypoint record and written by nothing, so
  // every photograph reported "local only" for ever — a geologist reopening an
  // observation could not tell whether its images had left the phone. The queue
  // knew the key the whole time and had no way to say so.
  test("every uploaded photo reports its key, once", async () => {
    const q = new PhotoUploadQueue({ storage: memoryStorage(), now: () => NOW });
    await q.enqueue("ms-abc", PHOTOS);
    const seen: Array<[string, string]> = [];
    await q.drain(happyDeps({ onUploaded: (id, key) => { seen.push([id, key]); } }));

    expect(seen).toEqual([
      ["p1", "missions/ms-abc/photos/p1.jpg"],
      ["p2", "missions/ms-abc/photos/p2.jpg"],
    ]);
  });

  test("a FAILED upload reports nothing", async () => {
    const q = new PhotoUploadQueue({ storage: memoryStorage(), now: () => NOW });
    await q.enqueue("ms-abc", PHOTOS);
    let called = 0;
    await q.drain(happyDeps({
      put: async () => ({ status: 403 }),
      onUploaded: () => { called++; },
    }));
    expect(called).toBe(0);
  });

  test("a throwing listener does NOT unmake the upload", async () => {
    // The bytes are in R2 either way. A bookkeeping error must never make a
    // delivered photograph look undelivered — that is how a mission ends up
    // re-uploading evidence it already has.
    const q = new PhotoUploadQueue({ storage: memoryStorage(), now: () => NOW });
    await q.enqueue("ms-abc", [PHOTOS[0]]);
    const r = await q.drain(happyDeps({
      onUploaded: () => { throw new Error("store is busy"); },
    }));
    expect(r.uploaded).toBe(1);
    expect(q.stats(NOW).uploaded).toBe(1);
  });

  test("re-draining does not report an already-uploaded photo again", async () => {
    const q = new PhotoUploadQueue({ storage: memoryStorage(), now: () => NOW });
    await q.enqueue("ms-abc", PHOTOS);
    await q.drain(happyDeps());
    let again = 0;
    await q.drain(happyDeps({ onUploaded: () => { again++; } }));
    expect(again).toBe(0);
  });
});
