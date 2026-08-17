// Draining the outbox — where the failures live.
//
// A field link times out, rejects one entry out of forty, or answers about
// entries nobody asked about. None of those may lose a record, and none may
// leave the queue spinning on something that will never be accepted.
import { pushOutbox, SYNC_TIMEOUT_MS } from "../sync/pushOutbox";
import { Outbox, RETRY_MAX_MS, type KeyValueAdapter } from "../sync/outbox";

jest.mock("../supabase", () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: { access_token: "t" } } }) } },
}));

function storage() {
  const store = new Map<string, string>();
  const adapter: KeyValueAdapter = {
    getItem: async (k) => store.get(k) ?? null,
    setItem: async (k, v) => { store.set(k, v); },
  };
  return adapter;
}

/** Same shape as storage(), but counts every setItem call — for measuring
 * how many times a drain rewrites the outbox to disk. */
function countingStorage() {
  const store = new Map<string, string>();
  let writes = 0;
  const adapter: KeyValueAdapter = {
    getItem: async (k) => store.get(k) ?? null,
    setItem: async (k, v) => { writes++; store.set(k, v); },
  };
  return { adapter, writes: () => writes };
}

async function queued(ids: string[]): Promise<Outbox> {
  const box = new Outbox({ storage: storage() });
  await box.enqueue("expedition.open", "ex-1", "ex-1", { started_at: "2026-08-05T09:00:00Z" });
  for (const id of ids) await box.enqueue("observation", "ex-1", id, { object_type: "outcrop" });
  return box;
}

const ok = (localId: string, kind: string) => ({ localId, kind, ok: true });

describe("pushOutbox", () => {
  test("offline is not an error — the queue simply waits", async () => {
    const box = await queued(["wp-1"]);
    const r = await pushOutbox(box, false);
    expect(r.blocked).toBe("offline");
    expect(box.pending()).toHaveLength(2);
  });

  test("an empty queue does nothing", async () => {
    const box = new Outbox({ storage: storage() });
    const post = jest.fn();
    const r = await pushOutbox(box, true, { post });
    expect(r.attempted).toBe(0);
    expect(post).not.toHaveBeenCalled();
  });

  test("accepted entries are marked off and never offered again", async () => {
    const box = await queued(["wp-1", "wp-2"]);
    const r = await pushOutbox(box, true, {
      post: async (entries) => entries.map((e) => ok(e.localId, e.kind)),
    });
    expect(r.accepted).toBe(3);
    expect(box.pending()).toHaveLength(0);
    expect(box.due()).toHaveLength(0);
  });

  test("a transport failure keeps everything queued and backs off", async () => {
    const box = await queued(["wp-1"]);
    const r = await pushOutbox(box, true, {
      post: async () => { throw new Error("network unreachable"); },
    });
    expect(r.blocked).toBe("transport");
    expect(box.pending()).toHaveLength(2);
    // Backoff applies, so this is not a hot retry loop.
    expect(box.due()).toHaveLength(0);
    expect(box.all()[0].lastError).toContain("network unreachable");
  });

  // THE ~52 SECOND FREEZE THIS FIXES. No `post` override here — this drives the
  // REAL postSync, whose fetch used to have no timeout at all. A stalled
  // connection (a socket accepted and then silent) never resolved and never
  // rejected, so a session resume that tried to drain sat there for as long as
  // the underlying platform was willing to wait — MEASURED at 51-52 SECONDS,
  // repeatedly, because `isOnline` flipping re-ran the drain each time and every
  // attempt hung on the same unbounded request.
  test("a fetch that never answers is aborted at SYNC_TIMEOUT_MS, not left hanging", async () => {
    jest.useFakeTimers();
    const box = await queued(["wp-1"]);

    // A fetch that mimics a stalled connection: it only ever settles if its
    // AbortSignal fires. Nothing else in this test can make it resolve.
    const fetchMock = jest.fn(
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const e = new Error("Aborted");
            e.name = "AbortError";
            reject(e);
          });
        }),
    );
    const originalFetch = global.fetch;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).fetch = fetchMock;

    try {
      const result = pushOutbox(box, true);
      // The async variant, not advanceTimersByTime — it interleaves flushing the
      // microtask queue with moving the clock, which a plain synchronous advance
      // does not, and the abort→reject→catch chain here is three awaits deep.
      await jest.advanceTimersByTimeAsync(SYNC_TIMEOUT_MS);
      const r = await result;

      expect(fetchMock).toHaveBeenCalledTimes(1);
      // A stalled request is an ordinary transport failure, not a forbidden one —
      // and above all, not an app that never answers.
      expect(r.blocked).toBe("transport");
      // Held on the device, exactly where it was before the attempt — never lost.
      expect(box.pending()).toHaveLength(2);
    } finally {
      global.fetch = originalFetch;
      jest.useRealTimers();
    }
  });

  test("a partial success is the normal outcome, not a rollback", async () => {
    const box = await queued(["good", "bad"]);
    const r = await pushOutbox(box, true, {
      post: async (entries) =>
        entries.map((e) =>
          e.localId === "bad"
            ? { localId: e.localId, kind: e.kind, ok: false, error: "server busy" }
            : ok(e.localId, e.kind)),
    });
    expect(r.accepted).toBe(2);
    expect(r.rejected).toBe(1);
    expect(box.pending().map((e) => e.localId)).toEqual(["bad"]);
  });

  test("a PERMANENT rejection stops being retried but keeps its reason", async () => {
    const box = await queued(["doomed"]);
    await pushOutbox(box, true, {
      post: async (entries) =>
        entries.map((e) =>
          e.localId === "doomed"
            ? { localId: e.localId, kind: e.kind, ok: false, permanent: true, error: "no_data_found" }
            : ok(e.localId, e.kind)),
    });
    // Not pending any more — it would fail identically for ever and holding a
    // queue slot open for it costs the records behind it.
    expect(box.pending()).toHaveLength(0);
    const entry = box.all().find((e) => e.localId === "doomed")!;
    expect(entry.sentAt).not.toBeNull();
    expect(entry.lastError).toContain("permanent");
  });

  test("silence about an entry is never taken as success", async () => {
    const box = await queued(["wp-1"]);
    await pushOutbox(box, true, {
      // The server answers about the expedition and forgets the observation.
      post: async (entries) => entries.filter((e) => e.kind === "expedition.open").map((e) => ok(e.localId, e.kind)),
    });
    expect(box.pending().map((e) => e.localId)).toEqual(["wp-1"]);
    expect(box.all().find((e) => e.localId === "wp-1")!.lastError).toBe("no result returned");
  });

  test("results are matched on kind AND id — the same id under two kinds is two records", async () => {
    const box = new Outbox({ storage: storage() });
    await box.enqueue("expedition.open", "ex-1", "ex-1", {});
    await box.enqueue("expedition.close", "ex-1", "ex-1", {});
    await pushOutbox(box, true, {
      post: async () => [{ localId: "ex-1", kind: "expedition.open", ok: true }],
    });
    // Only the open was acknowledged; the close is still owed.
    expect(box.pending().map((e) => e.kind)).toEqual(["expedition.close"]);
  });

  test("the batch is capped so a week offline does not become one huge request", async () => {
    const box = await queued(Array.from({ length: 300 }, (_, i) => "wp-" + i));
    let sent = 0;
    await pushOutbox(box, true, {
      post: async (entries) => { sent = entries.length; return entries.map((e) => ok(e.localId, e.kind)); },
    });
    expect(sent).toBeLessThanOrEqual(200);
    expect(box.pending().length).toBeGreaterThan(0);
  });

  // THE ~52 SECOND FREEZE, MEASURED DIRECTLY. Before this fix, the ack loop
  // below called outbox.markSent/markFailed/markRejected once per entry, each
  // persisting the WHOLE outbox on its own — 12 full serialise-and-write
  // passes for a 12-entry drain. On an SM-A165F with an 87-entry outbox, one
  // such persist measured ~52 seconds; 12 of them is the freeze this fixes.
  test("a 12-entry drain writes to storage once, not once per entry", async () => {
    const { adapter, writes } = countingStorage();
    const box = new Outbox({ storage: adapter });
    const ids = Array.from({ length: 12 }, (_, i) => "wp-" + i);
    for (const id of ids) await box.enqueue("observation", "ex-1", id, { object_type: "outcrop" });

    const before = writes();
    const r = await pushOutbox(box, true, {
      post: async (entries) =>
        entries.map((e, i) =>
          i % 4 === 0
            ? { localId: e.localId, kind: e.kind, ok: false, error: "server busy" }
            : ok(e.localId, e.kind)),
    });

    // BEFORE this fix this would be 12 (one per acknowledged entry). AFTER:
    // exactly one write for the whole batch.
    expect(writes() - before).toBe(1);
    expect(r.attempted).toBe(12);
    expect(r.accepted + r.rejected).toBe(12);
  });

  test("a whole-batch transport failure also writes once, not once per entry", async () => {
    const { adapter, writes } = countingStorage();
    const box = new Outbox({ storage: adapter });
    const ids = Array.from({ length: 12 }, (_, i) => "wp-" + i);
    for (const id of ids) await box.enqueue("observation", "ex-1", id, {});

    const before = writes();
    await pushOutbox(box, true, { post: async () => { throw new Error("network unreachable"); } });

    expect(writes() - before).toBe(1);
    expect(box.pending()).toHaveLength(12);
  });
});

// ── A refusal is not a network fault ────────────────────────────────────────
//
// /expeditions/sync calls requireEnterprise BEFORE it reads the body, so an
// account outside the enterprise allowlist gets a 403 for the whole batch. That
// was thrown as a plain Error and reported as `blocked: "transport"`, which reads
// as "bad signal" — so the field saw a rising "failing" count and no hint that
// the link, the phone and the records were all fine.
describe("why a drain failed is reported accurately", () => {
  const newOutbox = () => new Outbox({ storage: storage() });
  const entry = async (box: Outbox, id: string) => {
    await box.enqueue("observation", "ex-1", id, { type: "outcrop" });
  };

  /** A postSync that fails the way a real HTTP error does. */
  const httpFail = (status: number) => () => {
    const e = new Error(`sync failed (${status}) forbidden`);
    e.name = "SyncHttpError";
    (e as Error & { status: number }).status = status;
    return Promise.reject(e);
  };

  test("offline is offline, and nothing is attempted", async () => {
    const box = newOutbox();
    await entry(box, "a");
    const r = await pushOutbox(box, false);
    expect(r).toMatchObject({ attempted: 0, blocked: "offline" });
    // Untouched: no attempt was made, so no attempt is counted against it.
    expect(box.all()[0].attempts).toBe(0);
  });

  test("a 403 is reported as forbidden, never as transport", async () => {
    const box = newOutbox();
    await entry(box, "a");
    const r = await pushOutbox(box, true, { post: httpFail(403) });
    expect(r.blocked).toBe("forbidden");
    expect(r.reason).toContain("403");
  });

  test("a 401 is reported as forbidden too", async () => {
    const box = newOutbox();
    await entry(box, "a");
    const r = await pushOutbox(box, true, { post: httpFail(401) });
    expect(r.blocked).toBe("forbidden");
  });

  test("a 500 stays transport — the server is broken, not the account", async () => {
    const box = newOutbox();
    await entry(box, "a");
    const r = await pushOutbox(box, true, { post: httpFail(500) });
    expect(r.blocked).toBe("transport");
  });

  test("a refused batch is retried, and the reason is on every entry", async () => {
    const box = newOutbox();
    await entry(box, "a");
    await entry(box, "b");
    await pushOutbox(box, true, { post: httpFail(403) });

    // Not lost, not sent, and each one says why.
    const s = box.stats();
    expect(s.pending).toBe(2);
    expect(s.stored).toBe(2);
    expect(s.reasons).toHaveLength(1);
    expect(s.reasons[0]).toMatchObject({ count: 2, permanent: false });
    expect(s.reasons[0].reason).toContain("403");
  });

  test("entitlement granted later: the same records go through untouched", async () => {
    // A driven clock, because the refusal set a backoff and the whole point is
    // that the records come back round rather than being retried hot.
    let t = 1_000_000;
    const box = new Outbox({ storage: storage(), now: () => t });
    await entry(box, "a");
    await entry(box, "b");
    await pushOutbox(box, true, { post: httpFail(403) });
    expect(box.stats().pending).toBe(2);

    // Inside the backoff, nothing is even offered — that is what stops a hot loop.
    const early = await pushOutbox(box, true, { post: httpFail(403) });
    expect(early.attempted).toBe(0);

    t += RETRY_MAX_MS;
    // The allowlist now includes this account. Nothing was re-collected; the
    // records that were refused are the records that get filed.
    const ok = await pushOutbox(box, true, {
      post: async (due) => due.map((e) => ({ localId: e.localId, kind: e.kind, ok: true })),
    });
    expect(ok.accepted).toBe(2);
    expect(box.stats()).toMatchObject({ pending: 0, synced: 2, failing: 0 });
  });
});
