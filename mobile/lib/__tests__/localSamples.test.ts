// Samples, offline first.
//
// The tests that matter are about the failures a field connection actually
// produces: a submission that cannot be sent, an upload that dies between two
// photographs, a retry after a timeout, and a collection read with no signal.
// None of them may lose a sample, and none may create two.
import {
  LocalSampleStore, LOCAL_SAMPLE_STORAGE_KEY, retryDelayMs, RETRY_BASE_MS, RETRY_MAX_MS,
  type KeyValueAdapter, type PhotoFileAdapter,
} from "../samples/localSampleStore";
import { pushPendingSamples } from "../samples/pendingSampleSync";
import {
  loadCollection, mergeCollection, searchCollection, rowFromLocal, SAMPLE_LIST_CACHE_KEY,
} from "../samples/offlineSampleList";
import type { SampleListRow } from "../enterpriseSamples";

function storage(initial?: Record<string, string>) {
  const store = new Map<string, string>(Object.entries(initial ?? {}));
  const adapter: KeyValueAdapter = {
    getItem: async (k) => store.get(k) ?? null,
    setItem: async (k, v) => { store.set(k, v); },
  };
  return { adapter, store };
}

function files() {
  const copied: string[] = [];
  const removed: string[] = [];
  const adapter: PhotoFileAdapter = {
    persist: async (src, name) => {
      copied.push(name);
      return "file:///docs/enterprise/pending-samples/" + name;
    },
    remove: async (uri) => { removed.push(uri); },
  };
  return { adapter, copied, removed };
}

function clock(start = 1_800_000_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

function setup(initial?: Record<string, string>) {
  const c = clock();
  const s = storage(initial);
  const f = files();
  const store = new LocalSampleStore({ storage: s.adapter, files: f.adapter, now: c.now });
  return { store, c, files: f, store2: s };
}

const payload = {
  name: "Vein 3 grab",
  lat: 11.2833, lng: 49.1817,
  gps_accuracy_m: 4.6,
  collected_at: "2026-08-05T09:41:00.000Z",
  field_observations: "milky quartz with boxwork",
};

const photos = [
  { uri: "file:///cache/a.jpg", role: "context" as const },
  { uri: "file:///cache/b.jpg", role: "surface_closeup" as const },
];

describe("taking a sample with no signal", () => {
  test("it is saved, not failed", async () => {
    const { store } = setup();
    const s = await store.create({ payload, photos, expeditionSessionId: "ex-1" });

    expect(s.state).toBe("pending");
    expect(s.aiState).toBe("pending");
    expect(s.serverId).toBeNull();
    expect(store.stats()).toEqual({ pending: 1, failed: 0, uploaded: 0 });
  });

  test("the photographs are copied out of the OS cache", async () => {
    const { store, files: f } = setup();
    const s = await store.create({ payload, photos });
    expect(f.copied).toHaveLength(2);
    for (const p of s.photos) {
      expect(p.localUri).toContain("pending-samples");
      expect(p.storagePath).toBeNull();
    }
  });

  test("a photograph that cannot be copied keeps its original uri rather than being lost", async () => {
    const { store2 } = setup();
    const store = new LocalSampleStore({
      storage: store2.adapter,
      files: { persist: async () => { throw new Error("disk full"); }, remove: async () => {} },
    });
    const s = await store.create({ payload, photos: [photos[0]] });
    expect(s.photos[0].localUri).toBe("file:///cache/a.jpg");
  });

  test("it survives a restart, with the expedition it belongs to", async () => {
    const first = setup();
    await first.store.create({ payload, photos, expeditionSessionId: "ex-7" });
    const raw = first.store2.store.get(LOCAL_SAMPLE_STORAGE_KEY)!;

    const second = setup({ [LOCAL_SAMPLE_STORAGE_KEY]: raw });
    await second.store.load();
    expect(second.store.all()).toHaveLength(1);
    expect(second.store.all()[0].expeditionSessionId).toBe("ex-7");
    expect(second.store.all()[0].payload.name).toBe("Vein 3 grab");
  });

  test("a sample can be edited while it is still held here", async () => {
    const { store } = setup();
    const s = await store.create({ payload, photos });
    await store.update(s.localId, { name: "Vein 3 grab (corrected)" });
    expect(store.get(s.localId)!.payload.name).toBe("Vein 3 grab (corrected)");
  });
});

describe("uploading when the signal returns", () => {
  test("offline is not an error — nothing is attempted", async () => {
    const { store } = setup();
    await store.create({ payload, photos });
    const r = await pushPendingSamples(store, false);
    expect(r.blocked).toBe("offline");
    expect(store.stats().pending).toBe(1);
  });

  test("photographs then submission, and the sample is filed", async () => {
    const { store } = setup();
    const s = await store.create({ payload, photos });

    const r = await pushPendingSamples(store, true, {
      uploadPhoto: async (_uri, role) => ({ role, storage_path: `u/${role}.jpg` }),
      submit: async (input) => {
        expect(input.media).toHaveLength(2);
        expect(input.client_local_id).toBe(s.localId);
        return { sample_id: "srv-1" };
      },
    });

    expect(r.uploaded).toBe(1);
    const after = store.get(s.localId)!;
    expect(after.state).toBe("uploaded");
    expect(after.serverId).toBe("srv-1");
    // The server starts the analysis on create, so the device is now waiting.
    expect(after.aiState).toBe("queued");
  });

  test("a link that dies between photographs does not re-send the first one", async () => {
    const { store, c } = setup();
    const s = await store.create({ payload, photos });

    let uploads = 0;
    await pushPendingSamples(store, true, {
      uploadPhoto: async (_uri, role) => {
        uploads++;
        if (uploads === 2) throw new Error("connection lost");
        return { role, storage_path: `u/${role}.jpg` };
      },
      submit: async () => ({ sample_id: "never" }),
    });

    expect(store.get(s.localId)!.state).toBe("failed");
    // The first photograph is recorded as uploaded…
    expect(store.get(s.localId)!.photos[0].storagePath).toBe("u/context.jpg");
    expect(store.get(s.localId)!.photos[1].storagePath).toBeNull();

    // …so the retry, once the backoff has passed, only sends the second.
    c.advance(RETRY_BASE_MS);
    let secondRun = 0;
    await pushPendingSamples(store, true, {
      uploadPhoto: async (_uri, role) => { secondRun++; return { role, storage_path: `u/${role}.jpg` }; },
      submit: async () => ({ sample_id: "srv-2" }),
    });
    expect(secondRun).toBe(1);
    expect(store.get(s.localId)!.state).toBe("uploaded");
  });

  test("a retry after a timeout carries the same id — one sample, never two", async () => {
    const { store, c } = setup();
    const s = await store.create({ payload, photos });
    const ids: string[] = [];

    await pushPendingSamples(store, true, {
      uploadPhoto: async (_u, role) => ({ role, storage_path: "u.jpg" }),
      submit: async (input) => { ids.push(input.client_local_id); throw new Error("timeout"); },
    });

    // The backoff has to pass before it is offered again — that is the point of
    // a queue. What matters is that the SAME id goes up when it is.
    c.advance(RETRY_BASE_MS);
    await pushPendingSamples(store, true, {
      uploadPhoto: async (_u, role) => ({ role, storage_path: "u.jpg" }),
      submit: async (input) => { ids.push(input.client_local_id); return { sample_id: "srv-3" }; },
    });

    expect(ids).toEqual([s.localId, s.localId]);
    expect(store.all()).toHaveLength(1);
  });

  test("a failure backs off before it is tried again", async () => {
    const { store, c } = setup();
    await store.create({ payload, photos });
    await pushPendingSamples(store, true, {
      uploadPhoto: async () => { throw new Error("no route to host"); },
      submit: async () => ({ sample_id: "x" }),
    });

    expect(store.pending()).toHaveLength(0);       // waiting out the backoff
    c.advance(RETRY_BASE_MS);
    expect(store.pending()).toHaveLength(1);
  });

  test("backoff doubles and is capped", () => {
    expect(retryDelayMs(1)).toBe(RETRY_BASE_MS);
    expect(retryDelayMs(2)).toBe(RETRY_BASE_MS * 2);
    expect(retryDelayMs(50)).toBe(RETRY_MAX_MS);
  });

  test("one bad sample does not block the ones behind it", async () => {
    const { store, c } = setup();
    const bad = await store.create({ payload: { ...payload, name: "bad" }, photos: [photos[0]] });
    c.advance(10);
    const good = await store.create({ payload: { ...payload, name: "good" }, photos: [photos[0]] });

    await pushPendingSamples(store, true, {
      uploadPhoto: async (_u, role) => ({ role, storage_path: "u.jpg" }),
      submit: async (input) => {
        if (input.name === "bad") throw new Error("rejected");
        return { sample_id: "srv-good" };
      },
    });

    expect(store.get(bad.localId)!.state).toBe("failed");
    expect(store.get(good.localId)!.state).toBe("uploaded");
  });
});

describe("the collection reads offline", () => {
  const serverRow = (id: string, name: string): SampleListRow => ({
    id, name, collected_at: "2026-08-01T00:00:00.000Z", status: "submitted",
    completeness_status: null, completeness_score: null, ai_confidence: 72,
    ai_error: null, ai_attempted_at: null, geologist_confidence: null, confidence_score: null,
    area_id: "area-1", created_at: "2026-08-01T00:00:00.000Z",
  });

  test("with no signal it shows what the device holds", async () => {
    const { store, store2 } = setup();
    await store.create({ payload, photos });

    const r = await loadCollection(store, store2.adapter, {
      list: async () => { throw new Error("offline"); },
    });

    expect(r.fromCache).toBe(true);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].status).toBe("held_on_device");
    expect(r.rows[0].local?.photoCount).toBe(2);
  });

  test("a successful read is cached for the next time there is none", async () => {
    const { store, store2 } = setup();
    await loadCollection(store, store2.adapter, { list: async () => [serverRow("srv-1", "A")] });
    expect(store2.store.get(SAMPLE_LIST_CACHE_KEY)).toBeDefined();

    const offline = await loadCollection(store, store2.adapter, {
      list: async () => { throw new Error("offline"); },
    });
    expect(offline.fromCache).toBe(true);
    expect(offline.rows.map((x) => x.id)).toEqual(["srv-1"]);
  });

  test("a filed sample appears ONCE, as the server's version", async () => {
    const { store } = setup();
    const s = await store.create({ payload, photos });
    await store.markUploaded(s.localId, "srv-9");

    const rows = mergeCollection([serverRow("srv-9", "Vein 3 grab")], store.all());
    expect(rows).toHaveLength(1);
    // The server row wins — it carries the analysis — but keeps the local marks.
    expect(rows[0].ai_confidence).toBe(72);
    expect(rows[0].localId).toBe(s.localId);
    expect(rows[0].local?.state).toBe("uploaded");
  });

  test("a sample not yet filed cannot be confused with a server row", async () => {
    const { store } = setup();
    await store.create({ payload, photos });
    const rows = mergeCollection([serverRow("srv-1", "Other")], store.all());
    expect(rows).toHaveLength(2);
  });

  test("newest first, whatever it came from", async () => {
    const { store, c } = setup();
    c.advance(0);
    await store.create({ payload: { ...payload, collected_at: "2026-08-09T00:00:00.000Z" }, photos: [] });
    const rows = mergeCollection([serverRow("srv-1", "older")], store.all());
    expect(rows[0].collected_at).toBe("2026-08-09T00:00:00.000Z");
  });

  test("search covers local and server rows alike", async () => {
    const { store } = setup();
    await store.create({ payload: { ...payload, name: "Gossan ridge" }, photos: [] });
    const rows = mergeCollection([serverRow("srv-1", "Quartz float")], store.all());

    expect(searchCollection(rows, "gossan").map((r) => r.name)).toEqual(["Gossan ridge"]);
    expect(searchCollection(rows, "quartz").map((r) => r.name)).toEqual(["Quartz float"]);
    expect(searchCollection(rows, "held_on_device")).toHaveLength(1);
    expect(searchCollection(rows, "")).toHaveLength(2);
  });

  test("a local row is a complete collection row, so one list renders both", async () => {
    const { store } = setup();
    const s = await store.create({ payload, photos });
    const row = rowFromLocal(store.get(s.localId)!);
    expect(row.id).toBe(s.localId);
    expect(row.name).toBe("Vein 3 grab");
    expect(row.collected_at).toBe(payload.collected_at);
  });
});

describe("bounding what the device keeps", () => {
  test("a pending sample is never pruned — it is the only copy", async () => {
    const { store, c } = setup();
    for (let i = 0; i < 5; i++) {
      await store.create({ payload: { ...payload, name: "p" + i }, photos: [] });
      c.advance(1);
    }
    expect(store.stats().pending).toBe(5);
  });

  test("deleting a local sample takes its photographs with it", async () => {
    const { store, files: f } = setup();
    const s = await store.create({ payload, photos });
    await store.remove(s.localId);
    expect(store.all()).toHaveLength(0);
    expect(f.removed).toHaveLength(2);
  });
});

// ── One tap, one sample ─────────────────────────────────────────────────────
//
// The field collection showed "Dool dool dhadhaabta" three times, all stamped
// 07/08/2026 09:12:24, while every other sample appeared once. The server's
// idempotency could not have prevented it: create() mints a FRESH localId per
// call, so three taps produced three different idempotency keys, and three keys
// are three samples by definition.
//
// The guard is in the capture screen (a synchronous ref, because `canSubmit` is
// derived from React state and does not change until the next render). What is
// pinned HERE is the property that makes the guard load-bearing: that create()
// really does mint a new identity every time, so nothing downstream can collapse
// two calls back into one.
describe("create() mints one identity per call — which is why the tap must be guarded", () => {
  test("two calls with IDENTICAL content are two samples with two ids", async () => {
    const { store } = setup();
    const dool = {
      name: "Dool dool dhadhaabta",
      lat: 11.2842, lng: 49.1816,
      collected_at: "2026-08-07T09:12:24.000Z",
    } as never;

    const a = await store.create({ payload: dool, photos: [] });
    const b = await store.create({ payload: dool, photos: [] });

    expect(a.localId).not.toBe(b.localId);
    expect(store.all()).toHaveLength(2);
    // And each carries its own key, so the server sees two distinct submissions
    // and is right to file both. The duplicate was made here, not there.
    expect(new Set(store.all().map((s) => s.localId)).size).toBe(2);
  });

  test("three taps would be three server rows — the reported symptom, exactly", async () => {
    const { store } = setup();
    const dool = { name: "Dool dool dhadhaabta", lat: 11.2842, lng: 49.1816 } as never;
    for (let i = 0; i < 3; i++) await store.create({ payload: dool, photos: [] });
    expect(store.pending()).toHaveLength(3);
    expect(new Set(store.all().map((s) => s.localId)).size).toBe(3);
  });

  test("a retry of ONE sample keeps its id, so the server can dedupe it", async () => {
    // The other half of the contract: retrying must not mint a new key, or the
    // idempotency key would be worthless on exactly the path it exists for.
    const { store } = setup();
    const s = await store.create({ payload: { name: "Retry me" } as never, photos: [] });
    await store.markUploading(s.localId);
    await store.markFailed(s.localId, "Network request failed");
    await store.markUploading(s.localId);

    expect(store.all()).toHaveLength(1);
    expect(store.all()[0].localId).toBe(s.localId);
  });
});

// ── Attribution is sealed at capture, not at upload ─────────────────────────
//
// It used to be assigned server-side from whichever token carried the request.
// Over a long offline expedition that is wrong and silently so: sign out in the
// field, hand the phone to a colleague, and their token files observations under
// their name that they never made. For scientific data that is not a bug, it is
// a falsified record.
describe("who collected this is recorded on the device", () => {
  const AWMUSSE = { userId: "u-1", email: "awmusse@example.com" };

  test("a sample carries its collector from the moment it exists", async () => {
    const { store } = setup();
    const s = await store.create({ payload, photos: [], collectedBy: AWMUSSE });
    expect(s.collectedBy).toEqual(AWMUSSE);
  });

  test("it survives a restart, which is when it matters", async () => {
    // The colleague-with-the-phone case happens across app launches, so the
    // stamp is worthless if it lives only in memory.
    const s1 = storage();
    const f = files();
    const c = clock();
    const first = new LocalSampleStore({ storage: s1.adapter, files: f.adapter, now: c.now });
    const made = await first.create({ payload, photos: [], collectedBy: AWMUSSE });

    const second = new LocalSampleStore({ storage: s1.adapter, files: f.adapter, now: c.now });
    await second.load();
    expect(second.get(made.localId)!.collectedBy).toEqual(AWMUSSE);
  });

  test("no known identity records null rather than guessing", async () => {
    // Field work does not require an identity, and the app must not invent one.
    const { store } = setup();
    const s = await store.create({ payload, photos: [] });
    expect(s.collectedBy).toBeNull();
  });

  test("uploading does not rewrite it", async () => {
    // markUploaded assigns the server id. It must not touch provenance.
    const { store } = setup();
    const s = await store.create({ payload, photos: [], collectedBy: AWMUSSE });
    await store.markUploaded(s.localId, "srv-1");
    expect(store.get(s.localId)!.collectedBy).toEqual(AWMUSSE);
    expect(store.get(s.localId)!.serverId).toBe("srv-1");
  });
});
