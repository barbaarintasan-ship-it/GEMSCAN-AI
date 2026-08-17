// The outbox — nothing collected in the field is ever discarded.
//
// The tests that matter are the ones about failure: a timeout on a weak link
// must not duplicate a waypoint, a rejected entry must not dam the queue behind
// it, and a full queue must never drop work the server has not seen.
import {
  Outbox, retryDelayMs, RETRY_BASE_MS, RETRY_MAX_MS, OUTBOX_MAX_ENTRIES,
  OUTBOX_STORAGE_KEY, outboxStateOf, FAILING_ATTEMPTS, type KeyValueAdapter,
  type OutboxAckOutcome,
} from "../sync/outbox";

function fakeStorage(initial: string | null = null) {
  const store = new Map<string, string>();
  if (initial) store.set(OUTBOX_STORAGE_KEY, initial);
  const adapter: KeyValueAdapter = {
    getItem: async (k) => store.get(k) ?? null,
    setItem: async (k, v) => { store.set(k, v); },
  };
  return { adapter, store };
}

/** Same shape as fakeStorage, but counts every setItem call. */
function countingStorage(initial: string | null = null) {
  const { adapter, store } = fakeStorage(initial);
  let writes = 0;
  const counted: KeyValueAdapter = {
    getItem: adapter.getItem,
    setItem: async (k, v) => { writes++; await adapter.setItem(k, v); },
  };
  return { adapter: counted, store, writes: () => writes };
}

/** A clock the test drives, so backoff can be exercised without waiting. */
function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe("enqueueing", () => {
  test("a record is durable the moment it exists", async () => {
    const { adapter, store } = fakeStorage();
    const box = new Outbox({ storage: adapter });
    await box.enqueue("observation", "ex-1", "wp-1", { type: "outcrop" });

    const raw = store.get(OUTBOX_STORAGE_KEY);
    expect(raw).toBeDefined();
    expect(JSON.parse(raw!).entries).toHaveLength(1);
  });

  test("it survives a restart", async () => {
    const { adapter, store } = fakeStorage();
    const first = new Outbox({ storage: adapter });
    await first.enqueue("observation", "ex-1", "wp-1", { type: "float" });

    const second = new Outbox({ storage: fakeStorage(store.get(OUTBOX_STORAGE_KEY)!).adapter });
    await second.load();
    expect(second.pending()).toHaveLength(1);
    expect(second.pending()[0].payload).toEqual({ type: "float" });
  });

  test("re-queuing the same record replaces it — an edit is one row, not two", async () => {
    const box = new Outbox({ storage: fakeStorage().adapter });
    await box.enqueue("observation", "ex-1", "wp-1", { notes: "first" });
    await box.enqueue("observation", "ex-1", "wp-1", { notes: "corrected" });
    expect(box.pending()).toHaveLength(1);
    expect(box.pending()[0].payload).toEqual({ notes: "corrected" });
  });

  test("the same id under a different kind is a different record", async () => {
    const box = new Outbox({ storage: fakeStorage().adapter });
    await box.enqueue("expedition.open", "ex-1", "ex-1", {});
    await box.enqueue("expedition.close", "ex-1", "ex-1", {});
    expect(box.pending()).toHaveLength(2);
  });

  test("an unreadable queue starts empty rather than ending the session", async () => {
    const box = new Outbox({ storage: fakeStorage("{not json").adapter });
    await box.load();
    expect(box.pending()).toEqual([]);
  });
});

describe("draining order", () => {
  test("oldest first — an observation cannot precede the expedition it belongs to", async () => {
    const c = clock();
    const box = new Outbox({ storage: fakeStorage().adapter, now: c.now });
    await box.enqueue("expedition.open", "ex-1", "ex-1", {});
    c.advance(1000);
    await box.enqueue("observation", "ex-1", "wp-1", {});
    c.advance(1000);
    await box.enqueue("observation", "ex-1", "wp-2", {});

    expect(box.due().map((e) => e.localId)).toEqual(["ex-1", "wp-1", "wp-2"]);
  });

  test("what the server accepted is not offered again", async () => {
    const box = new Outbox({ storage: fakeStorage().adapter });
    await box.enqueue("observation", "ex-1", "wp-1", {});
    await box.markSent("wp-1", "observation");
    expect(box.due()).toEqual([]);
    expect(box.stats()).toMatchObject({ pending: 0, sent: 1, failing: 0 });
  });
});

describe("failure handling", () => {
  test("a failure backs off, then becomes due again", async () => {
    const c = clock();
    const box = new Outbox({ storage: fakeStorage().adapter, now: c.now });
    await box.enqueue("observation", "ex-1", "wp-1", {});
    await box.markFailed("wp-1", "observation", "network");

    // Immediately after, it is held back.
    expect(box.due()).toEqual([]);
    c.advance(RETRY_BASE_MS);
    expect(box.due().map((e) => e.localId)).toEqual(["wp-1"]);
  });

  test("one poisoned entry does not dam the queue behind it", async () => {
    const c = clock();
    const box = new Outbox({ storage: fakeStorage().adapter, now: c.now });
    await box.enqueue("observation", "ex-1", "bad", {});
    c.advance(10);
    await box.enqueue("observation", "ex-1", "good", {});
    await box.markFailed("bad", "observation", "rejected");

    // The good one is still offered while the bad one waits out its backoff.
    expect(box.due().map((e) => e.localId)).toEqual(["good"]);
  });

  test("backoff doubles and is capped", () => {
    expect(retryDelayMs(1)).toBe(RETRY_BASE_MS);
    expect(retryDelayMs(2)).toBe(RETRY_BASE_MS * 2);
    expect(retryDelayMs(3)).toBe(RETRY_BASE_MS * 4);
    expect(retryDelayMs(99)).toBe(RETRY_MAX_MS);
  });

  test("repeated failure is surfaced rather than hidden", async () => {
    const c = clock();
    const box = new Outbox({ storage: fakeStorage().adapter, now: c.now });
    await box.enqueue("observation", "ex-1", "wp-1", {});
    for (let i = 0; i < 3; i++) {
      await box.markFailed("wp-1", "observation", "boom");
      c.advance(RETRY_MAX_MS);
    }
    expect(box.stats().failing).toBe(1);
    expect(box.all()[0].lastError).toBe("boom");
  });

  test("a permanently rejected entry leaves the queue but keeps its reason", async () => {
    const box = new Outbox({ storage: fakeStorage().adapter });
    await box.enqueue("observation", "ex-1", "wp-1", {});
    await box.markRejected("wp-1", "observation", "no_data_found");

    expect(box.pending()).toEqual([]);
    // The reason survives — this is the one case where the error IS the record.
    expect(box.all()[0].lastError).toContain("permanent");
    expect(box.all()[0].lastError).toContain("no_data_found");
  });

  test("an error message is recorded but bounded", async () => {
    const box = new Outbox({ storage: fakeStorage().adapter });
    await box.enqueue("observation", "ex-1", "wp-1", {});
    await box.markFailed("wp-1", "observation", "x".repeat(5000));
    expect(box.all()[0].lastError!.length).toBeLessThanOrEqual(300);
  });
});

describe("bounding the queue", () => {
  test("sent entries are dropped first, oldest first", async () => {
    const c = clock();
    const box = new Outbox({ storage: fakeStorage().adapter, now: c.now });
    for (let i = 0; i < OUTBOX_MAX_ENTRIES; i++) {
      await box.enqueue("observation", "ex-1", "sent-" + i, {});
      await box.markSent("sent-" + i, "observation");
      c.advance(1);
    }
    await box.enqueue("observation", "ex-1", "fresh", {});
    expect(box.all().length).toBeLessThanOrEqual(OUTBOX_MAX_ENTRIES);
    expect(box.all().some((e) => e.localId === "fresh")).toBe(true);
    // The oldest ACCEPTED record went; nothing unsent was touched.
    expect(box.all().some((e) => e.localId === "sent-0")).toBe(false);
  });

  test("work the server has not seen is never dropped, even over the cap", async () => {
    const box = new Outbox({ storage: fakeStorage().adapter });
    for (let i = 0; i < OUTBOX_MAX_ENTRIES + 25; i++) {
      await box.enqueue("observation", "ex-1", "wp-" + i, {});
    }
    // The cap is exceeded on purpose: losing a geologist's observations to make
    // room for newer ones is not a trade this app is allowed to make.
    expect(box.pending()).toHaveLength(OUTBOX_MAX_ENTRIES + 25);
  });
});

describe("subscribers", () => {
  test("a change notifies, so a status line can show what is owed", async () => {
    const box = new Outbox({ storage: fakeStorage().adapter });
    let seen = 0;
    box.subscribe(() => { seen++; });
    await box.enqueue("observation", "ex-1", "wp-1", {});
    expect(seen).toBeGreaterThan(0);
  });
});

// ── The queue is observable ──────────────────────────────────────────────────
//
// The field build reported "8 held · 4 failing" and stopped there. The reason for
// each of those four was already on disk, in the entry that failed. These tests
// pin the five states apart and pin the reason to the surface, because a failure
// a geologist cannot see is one they cannot act on.
describe("every record has one state, and it is the true one", () => {
  const box = () => new Outbox({ storage: fakeStorage().adapter, now: () => 1_000_000 });

  test("a fresh record is queued", async () => {
    const b = box();
    await b.enqueue("observation", "ex-1", "wp-1", {});
    expect(outboxStateOf(b.all()[0])).toBe("queued");
    expect(b.stats().queued).toBe(1);
  });

  test("one failure is retrying, not failing — the link drops all the time", async () => {
    const b = box();
    await b.enqueue("observation", "ex-1", "wp-1", {});
    await b.markFailed("wp-1", "observation", "timeout");
    expect(outboxStateOf(b.all()[0])).toBe("retrying");
    expect(b.stats()).toMatchObject({ retrying: 1, failing: 0, pending: 1 });
  });

  test("FAILING_ATTEMPTS failures is failing, and it is still retried", async () => {
    const c = clock();
    const b = new Outbox({ storage: fakeStorage().adapter, now: c.now });
    await b.enqueue("observation", "ex-1", "wp-1", {});
    for (let i = 0; i < FAILING_ATTEMPTS; i++) {
      await b.markFailed("wp-1", "observation", "sync failed (403) forbidden");
      c.advance(RETRY_MAX_MS);
    }
    expect(outboxStateOf(b.all()[0])).toBe("failing");
    expect(b.stats().failing).toBe(1);
    // Failing is a label, not a grave. It must still come back round.
    expect(b.due().map((e) => e.localId)).toEqual(["wp-1"]);
  });

  test("a permanent rejection is 'rejected' and keeps its reason", async () => {
    const b = box();
    await b.enqueue("observation", "ex-1", "wp-1", {});
    await b.markRejected("wp-1", "observation", "invalid input");
    expect(outboxStateOf(b.all()[0])).toBe("rejected");
    expect(b.stats()).toMatchObject({ rejected: 1, synced: 0, pending: 0 });
    expect(b.stats().reasons).toEqual([{ reason: "invalid input", count: 1, permanent: true }]);
  });

  test("an accepted record is synced and carries no reason", async () => {
    const b = box();
    await b.enqueue("observation", "ex-1", "wp-1", {});
    await b.markFailed("wp-1", "observation", "timeout");
    await b.markSent("wp-1", "observation");
    expect(outboxStateOf(b.all()[0])).toBe("synced");
    expect(b.stats()).toMatchObject({ synced: 1, pending: 0 });
    // A successful retry clears a stale error rather than leaving it on display.
    expect(b.stats().reasons).toEqual([]);
  });

  test("stored counts everything, in every state — nothing is invisible", async () => {
    const b = box();
    await b.enqueue("observation", "ex-1", "a", {});
    await b.enqueue("observation", "ex-1", "b", {});
    await b.enqueue("observation", "ex-1", "c", {});
    await b.markSent("a", "observation");
    await b.markFailed("b", "observation", "timeout");
    const s = b.stats();
    expect(s.stored).toBe(3);
    expect(s.synced + s.rejected + s.queued + s.retrying + s.failing).toBe(3);
  });
});

describe("the reason is grouped, not buried", () => {
  test("one cause behind many entries is reported once, with a count", async () => {
    const b = new Outbox({ storage: fakeStorage().adapter, now: () => 1_000_000 });
    for (const id of ["a", "b", "c", "d"]) {
      await b.enqueue("observation", "ex-1", id, {});
      await b.markFailed(id, "observation", "sync failed (403) forbidden");
    }
    await b.enqueue("track", "ex-1", "t1", {});
    await b.markFailed("t1", "track", "Network request failed");

    expect(b.stats().reasons).toEqual([
      { reason: "sync failed (403) forbidden", count: 4, permanent: false },
      { reason: "Network request failed", count: 1, permanent: false },
    ]);
  });

  test("the next retry time is the EARLIEST one, so the panel never overstates the wait", async () => {
    const c = clock();
    const b = new Outbox({ storage: fakeStorage().adapter, now: c.now });
    await b.enqueue("observation", "ex-1", "old", {});
    await b.markFailed("old", "observation", "timeout");   // 1 attempt -> 15 s
    c.advance(5_000);
    await b.enqueue("observation", "ex-1", "new", {});
    await b.markFailed("new", "observation", "timeout");

    expect(b.stats().nextRetryAt).toBe(c.now() - 5_000 + RETRY_BASE_MS);
  });

  test("worst first — what needs looking at is not below the noise", async () => {
    const b = new Outbox({ storage: fakeStorage().adapter, now: () => 1_000_000 });
    await b.enqueue("observation", "ex-1", "ok", {});
    await b.markSent("ok", "observation");
    await b.enqueue("observation", "ex-1", "fresh", {});
    await b.enqueue("observation", "ex-1", "bad", {});
    for (let i = 0; i < FAILING_ATTEMPTS; i++) await b.markFailed("bad", "observation", "403");

    expect(b.byState().map((x) => x.state)).toEqual(["failing", "queued", "synced"]);
  });
});

describe("no record is lost, whatever happens to it", () => {
  test("a failing entry survives a restart with its attempt count and reason", async () => {
    const { adapter } = fakeStorage();
    const first = new Outbox({ storage: adapter, now: () => 1_000_000 });
    await first.enqueue("observation", "ex-1", "wp-1", { type: "outcrop" });
    for (let i = 0; i < FAILING_ATTEMPTS; i++) {
      await first.markFailed("wp-1", "observation", "sync failed (403) forbidden");
    }

    // A phone that died in a wadi, restarted the next morning.
    const second = new Outbox({ storage: adapter, now: () => 2_000_000 });
    await second.load();
    const e = second.all()[0];
    expect(e.attempts).toBe(FAILING_ATTEMPTS);
    expect(e.lastError).toBe("sync failed (403) forbidden");
    expect(outboxStateOf(e)).toBe("failing");
    // And it is offered again — the backoff was measured from the old clock.
    expect(second.due().map((x) => x.localId)).toEqual(["wp-1"]);
  });

  test("a queue full of FAILING work grows past the cap rather than dropping any", async () => {
    const b = new Outbox({ storage: fakeStorage().adapter, now: () => 1_000_000 });
    for (let i = 0; i < OUTBOX_MAX_ENTRIES + 25; i++) {
      await b.enqueue("observation", "ex-1", "wp-" + i, {});
      await b.markFailed("wp-" + i, "observation", "403");
    }
    expect(b.stats().stored).toBe(OUTBOX_MAX_ENTRIES + 25);
    expect(b.stats().pending).toBe(OUTBOX_MAX_ENTRIES + 25);
  });
});

// ── Batched acknowledgement (applyResults) ───────────────────────────────────
//
// THE ~52 SECOND FREEZE THIS FIXES. markSent/markFailed/markRejected each
// persist immediately — a full JSON.stringify + AsyncStorage.setItem of the
// WHOLE outbox — which is right for a single, isolated update but was also
// what pushOutbox() did once per entry in a batch it just heard back on, up to
// BATCH_SIZE (200) times per drain. Measured on an SM-A165F with an 87-entry
// outbox: one persist took ~52 seconds, and a 12-entry drain called it 12
// times. applyResults() applies every outcome in memory and persists once.
describe("batched acknowledgement (applyResults)", () => {
  test("multiple acknowledgements cause only one persist write", async () => {
    const { adapter, writes } = countingStorage();
    const box = new Outbox({ storage: adapter });
    const ids = Array.from({ length: 12 }, (_, i) => "wp-" + i);
    for (const id of ids) await box.enqueue("observation", "ex-1", id, { n: id });

    const before = writes();
    const outcomes: OutboxAckOutcome[] = ids.map((id, i) =>
      i % 3 === 0
        ? { localId: id, kind: "observation", result: "sent" }
        : i % 3 === 1
          ? { localId: id, kind: "observation", result: "failed", error: "server busy" }
          : { localId: id, kind: "observation", result: "rejected", error: "no_data_found" });
    await box.applyResults(outcomes);

    // Exactly one write for the whole batch, whatever its size — not one per
    // acknowledged entry (that would be 12 here, on top of the 12 enqueues).
    expect(writes() - before).toBe(1);
  });

  test("an empty batch persists nothing at all", async () => {
    const { adapter, writes } = countingStorage();
    const box = new Outbox({ storage: adapter });
    await box.enqueue("observation", "ex-1", "wp-1", {});
    const before = writes();
    await box.applyResults([]);
    expect(writes()).toBe(before);
  });

  test("failed entries remain queued correctly after a batched ack", async () => {
    const c = clock();
    const box = new Outbox({ storage: fakeStorage().adapter, now: c.now });
    await box.enqueue("observation", "ex-1", "wp-1", {});
    await box.enqueue("observation", "ex-1", "wp-2", {});

    await box.applyResults([
      { localId: "wp-1", kind: "observation", result: "failed", error: "timeout" },
      { localId: "wp-2", kind: "observation", result: "sent" },
    ]);

    // The failed one is still owed, still in the queue, and holds its reason —
    // exactly as a single markFailed call would leave it.
    expect(box.pending().map((e) => e.localId)).toEqual(["wp-1"]);
    const failed = box.all().find((e) => e.localId === "wp-1")!;
    expect(failed.attempts).toBe(1);
    expect(failed.lastError).toBe("timeout");
    expect(failed.sentAt).toBeNull();

    // Immediately after, it is backed off, same as the single-entry path.
    expect(box.due().map((e) => e.localId)).toEqual([]);
    c.advance(RETRY_BASE_MS);
    expect(box.due().map((e) => e.localId)).toEqual(["wp-1"]);
  });

  test("sent and rejected states from a batch are byte-identical to the single-call path", async () => {
    const now = () => 1_000_000;

    // Reference: the existing per-call methods, one persist each.
    const single = new Outbox({ storage: fakeStorage().adapter, now });
    await single.enqueue("observation", "ex-1", "sent-1", {});
    await single.enqueue("observation", "ex-1", "rejected-1", {});
    await single.markSent("sent-1", "observation");
    await single.markRejected("rejected-1", "observation", "no_data_found");

    // Same two outcomes, applied as one batch.
    const batched = new Outbox({ storage: fakeStorage().adapter, now });
    await batched.enqueue("observation", "ex-1", "sent-1", {});
    await batched.enqueue("observation", "ex-1", "rejected-1", {});
    await batched.applyResults([
      { localId: "sent-1", kind: "observation", result: "sent" },
      { localId: "rejected-1", kind: "observation", result: "rejected", error: "no_data_found" },
    ]);

    expect(batched.all()).toEqual(single.all());
    expect(batched.stats()).toEqual(single.stats());
  });

  test("an outcome for an entry that no longer exists is skipped, not an error", async () => {
    const box = new Outbox({ storage: fakeStorage().adapter });
    await box.enqueue("observation", "ex-1", "wp-1", {});
    await expect(box.applyResults([
      { localId: "wp-1", kind: "observation", result: "sent" },
      { localId: "ghost", kind: "observation", result: "sent" },
    ])).resolves.toBeUndefined();
    expect(box.all()).toHaveLength(1);
    expect(box.all()[0].sentAt).not.toBeNull();
  });
});
