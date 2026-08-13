// The lease — what makes field work outlive a token.
//
// Two failures ended the Karkaar expedition, and they are different:
//
//   1. The token expired after ~1 h. `onAuthStateChange` propagated a null
//      session and (app)/_layout redirected to a login screen that needs a
//      network. Fixed by reading the lease before the gate decides.
//   2. Android kills a backgrounded app overnight. On the next launch every
//      in-memory trace of the expedition is gone, so app/index.tsx decided on
//      `session` alone and landed on login again. Fixed by putting the lease in
//      storage.
//
// Both are asserted here. So is the property that makes the whole thing safe:
// attribution is sealed at open and NO account action rewrites it.
import {
  ExpeditionLeaseStore, LEASE_CLOSURE_KEY, LEASE_STORAGE_KEY, MAX_LEASE_MS,
} from "../exploration/expeditionLease";
import type { KeyValueAdapter } from "../samples/localSampleStore";

function storage(initial?: string) {
  const store = new Map<string, string>();
  if (initial) store.set(LEASE_STORAGE_KEY, initial);
  const adapter: KeyValueAdapter = {
    getItem: async (k) => store.get(k) ?? null,
    setItem: async (k, v) => { store.set(k, v); },
  };
  return { adapter, store };
}

function clock(start = 1_800_000_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

const AWMUSSE = { userId: "u-1", email: "awmusse@example.com" };
const OTHER = { userId: "u-2", email: "someone.else@example.com" };

const make = (s = storage(), c = clock()) => ({
  s, c,
  store: new ExpeditionLeaseStore({ storage: s.adapter, now: c.now, build: () => "1.9.6 (78)" }),
});

describe("opening a lease", () => {
  test("a lease seals who is collecting, and the build that recorded it", async () => {
    const { store } = make();
    await store.open("ex-1", AWMUSSE);
    const lease = store.get()!;
    expect(lease.expeditionId).toBe("ex-1");
    expect(lease.collectedBy).toEqual(AWMUSSE);
    expect(lease.state).toBe("attached");
    // Provenance, not telemetry: a record has to say which code produced it.
    expect(lease.build).toBe("1.9.6 (78)");
  });

  test("re-opening the SAME expedition does not reseal it", async () => {
    // A remount must not reset openedAt (the lease would forget how long the
    // geologist has been out) nor reseal attribution to whoever is signed in now.
    const { store, c } = make();
    await store.open("ex-1", AWMUSSE);
    const first = store.get()!;
    c.advance(6 * 60 * 60 * 1000);
    await store.open("ex-1", OTHER);
    expect(store.get()!.openedAt).toBe(first.openedAt);
    expect(store.get()!.collectedBy).toEqual(AWMUSSE);
  });

  test("a lease with no known identity is still a lease", async () => {
    // Field work does not require an identity. Recording must not be blocked
    // because nobody could be named.
    const { store } = make();
    await store.open("ex-1", null);
    expect(store.isOpen()).toBe(true);
    expect(store.get()!.collectedBy).toBeNull();
  });
});

describe("surviving a process kill — the overnight failure", () => {
  test("a lease written by one process is read by the next", async () => {
    const s = storage();
    const c = clock();
    const first = new ExpeditionLeaseStore({ storage: s.adapter, now: c.now });
    await first.open("ex-1", AWMUSSE);

    // Android reclaimed the app. New process, nothing in memory.
    c.advance(9 * 60 * 60 * 1000);
    const second = new ExpeditionLeaseStore({ storage: s.adapter, now: c.now });
    await second.load();

    expect(second.isOpen()).toBe(true);
    expect(second.get()!.expeditionId).toBe("ex-1");
    // And attribution came back with it, so records taken after the restart
    // still belong to the person who started the walk.
    expect(second.get()!.collectedBy).toEqual(AWMUSSE);
  });

  test("an unreadable lease is the same as none — it never takes out the app", async () => {
    const s = storage("{not json at all");
    const store = new ExpeditionLeaseStore({ storage: s.adapter });
    await store.load();
    expect(store.get()).toBeNull();
    expect(store.isOpen()).toBe(false);
  });

  test("a lease from a future schema is ignored rather than trusted", async () => {
    const s = storage(JSON.stringify({ version: 99, lease: { expeditionId: "x" } }));
    const store = new ExpeditionLeaseStore({ storage: s.adapter });
    await store.load();
    expect(store.get()).toBeNull();
  });
});

describe("detaching — logout does not end the expedition", () => {
  test("the lease stays open and the collector is NOT cleared", async () => {
    // The whole policy in one assertion. Signing out revokes the ability to
    // upload as that account; it does not restate who collected what.
    const { store } = make();
    await store.open("ex-1", AWMUSSE);
    await store.detach();

    expect(store.isOpen()).toBe(true);
    expect(store.isDetached()).toBe(true);
    expect(store.get()!.collectedBy).toEqual(AWMUSSE);
    expect(store.get()!.detachedAt).not.toBeNull();
  });

  test("detached survives a process kill too", async () => {
    const s = storage();
    const first = new ExpeditionLeaseStore({ storage: s.adapter });
    await first.open("ex-1", AWMUSSE);
    await first.detach();

    const second = new ExpeditionLeaseStore({ storage: s.adapter });
    await second.load();
    expect(second.isDetached()).toBe(true);
    expect(second.isOpen()).toBe(true);
  });

  test("signing back in re-attaches without touching attribution", async () => {
    const { store } = make();
    await store.open("ex-1", AWMUSSE);
    await store.detach();
    await store.reattach();
    expect(store.isDetached()).toBe(false);
    expect(store.get()!.detachedAt).toBeNull();
    expect(store.get()!.collectedBy).toEqual(AWMUSSE);
  });

  test("detaching twice is not an error", async () => {
    const { store, c } = make();
    await store.open("ex-1", AWMUSSE);
    await store.detach();
    const first = store.get()!.detachedAt;
    c.advance(60_000);
    await store.detach();
    expect(store.get()!.detachedAt).toBe(first);
  });
});

describe("closing — the only ordinary way out", () => {
  test("the geologist ending the walk closes the lease", async () => {
    const { store } = make();
    await store.open("ex-1", AWMUSSE);
    await store.close();
    expect(store.get()).toBeNull();
    expect(store.isOpen()).toBe(false);
  });

  test("a closed lease does not come back after a restart", async () => {
    const s = storage();
    const first = new ExpeditionLeaseStore({ storage: s.adapter });
    await first.open("ex-1", AWMUSSE);
    await first.close();

    const second = new ExpeditionLeaseStore({ storage: s.adapter });
    await second.load();
    expect(second.isOpen()).toBe(false);
  });
});

describe("the safety net, and what it must not be", () => {
  test("a lease keeps holding the gate for as long as an expedition could last", async () => {
    const { store, c } = make();
    await store.open("ex-1", AWMUSSE);
    // Seven days, 500 km from anywhere — the requirement this exists for.
    c.advance(7 * 24 * 60 * 60 * 1000);
    expect(store.isOpen()).toBe(true);
  });

  test("but a lease nobody ever closed self-heals", async () => {
    // Not a limit on the expedition — the geologist alone ends that. This is the
    // net for a lease orphaned by a crash during teardown.
    const { store, c } = make();
    await store.open("ex-1", AWMUSSE);
    c.advance(MAX_LEASE_MS + 1);
    expect(store.isOpen()).toBe(false);
    // The record itself is kept: observations still refer to this expedition.
    expect(store.get()).not.toBeNull();
  });
});

describe("a walk may not end anonymously", () => {
  // An expedition disappeared between two installed builds and nothing on the
  // device could say when or why: close() set the lease to null and persisted
  // that. The record below is what makes the next occurrence answerable instead
  // of another guess.
  const NOW = 1_800_000_000_000;

  function store(initial?: string) {
    const map = new Map<string, string>();
    if (initial) map.set(LEASE_STORAGE_KEY, initial);
    const adapter: KeyValueAdapter = {
      getItem: async (k) => map.get(k) ?? null,
      setItem: async (k, v) => { map.set(k, v); },
    };
    return { adapter, map };
  }

  test("closing records the expedition, the clock and the build", async () => {
    const st = store();
    const s = new ExpeditionLeaseStore({
      storage: st.adapter, now: () => NOW, build: () => "1.11.0 (87)",
    });
    await s.open("ex-abc", { userId: "u1", email: "a@b.c" });
    await s.close();

    const c = s.lastClosure()!;
    expect(c.expeditionId).toBe("ex-abc");
    expect(c.reason).toBe("ended");
    expect(c.closedAt).toBe(NOW);
    expect(c.build).toBe("1.11.0 (87)");
    // And it is on disk under its own key, so it outlives the lease it describes.
    expect(st.map.get(LEASE_CLOSURE_KEY)).toContain("ex-abc");
  });

  test("the record survives the restart that loses the lease", async () => {
    const st = store();
    const first = new ExpeditionLeaseStore({ storage: st.adapter, now: () => NOW });
    await first.open("ex-karkaar", null);
    await first.close();

    const second = new ExpeditionLeaseStore({ storage: st.adapter, now: () => NOW });
    await second.load();
    expect(second.get()).toBeNull();                       // the lease is gone
    expect(second.lastClosure()?.expeditionId).toBe("ex-karkaar");  // the reason is not
  });

  test("nothing is recorded when there was no lease to close", async () => {
    const s = new ExpeditionLeaseStore({ storage: store().adapter, now: () => NOW });
    await s.close();
    expect(s.lastClosure()).toBeNull();
  });

  test("a failed write does not stop the walk from ending", async () => {
    // Refusing to end an expedition because a diagnostic could not be saved
    // would be the tail wagging the dog.
    const adapter: KeyValueAdapter = {
      getItem: async () => null,
      setItem: async (k) => { if (k === LEASE_CLOSURE_KEY) throw new Error("disk full"); },
    };
    const s = new ExpeditionLeaseStore({ storage: adapter, now: () => NOW });
    await s.open("ex-x", null);
    await expect(s.close()).resolves.toBeUndefined();
    expect(s.get()).toBeNull();
  });

  test("an unreadable record is ignored rather than thrown", async () => {
    const adapter: KeyValueAdapter = {
      getItem: async (k) => (k === LEASE_CLOSURE_KEY ? "{not json" : null),
      setItem: async () => {},
    };
    const s = new ExpeditionLeaseStore({ storage: adapter, now: () => NOW });
    await s.load();
    expect(s.lastClosure()).toBeNull();
  });
});
