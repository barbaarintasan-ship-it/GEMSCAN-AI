// Field Exploration Engine — Phase 1 unit tests (spec Part 8).
//
// Pure tests over the exported transition table plus the services/controller
// with injected fakes — no expo, no react-native, no timers left running.
import {
  WALKING_PROFILE,
  type FieldFix,
  type MachineSnapshot,
  type SessionEvent,
} from "../field/types";
import {
  LocationService,
  type LocationApi,
  type RawFix,
} from "../field/locationService";
import {
  HeadingService,
  angularDelta,
  circularSmooth,
  type HeadingApi,
  type RawHeading,
} from "../field/headingService";
import { DiagnosticsRecorder } from "../field/diagnostics";
import {
  FieldSessionController,
  transition,
  type AppStateApi,
} from "../field/sessionController";

// ── Helpers ─────────────────────────────────────────────────────────────────
const snap = (state: MachineSnapshot["state"], pausedBy: MachineSnapshot["pausedBy"] = null): MachineSnapshot =>
  ({ state, pausedBy, errorCode: null });
const ev = (type: SessionEvent["type"]): SessionEvent => ({ type } as SessionEvent);

const rawFix = (lat = 2.05, lng = 45.32, accuracy = 8): RawFix => ({
  coords: { latitude: lat, longitude: lng, accuracy, altitude: 10, speed: 1 },
  timestamp: Date.now(),
});

function flush(times = 6): Promise<void> {
  // Drain chained microtasks from the async start flow.
  let p: Promise<void> = Promise.resolve();
  for (let i = 0; i < times; i++) p = p.then(() => Promise.resolve());
  return p;
}

function fakeLocationApi(overrides: Partial<LocationApi> = {}) {
  const watchCbs: Array<(f: RawFix) => void> = [];
  const removed: number[] = [];
  const api: LocationApi & { watchCbs: typeof watchCbs; removed: typeof removed } = {
    watchCbs,
    removed,
    requestPermissions: async () => ({ granted: true, preciseGranted: true, canAskAgain: true }),
    servicesEnabled: async () => true,
    lastKnown: async () => null,
    currentFix: async () => rawFix(),
    watch: async (_profile, cb) => {
      watchCbs.push(cb);
      const idx = watchCbs.length - 1;
      return { remove: () => removed.push(idx) };
    },
    ...overrides,
  };
  return api;
}

function fakeHeadingApi(overrides: Partial<HeadingApi> = {}) {
  const cbs: Array<(h: RawHeading) => void> = [];
  const api: HeadingApi & { cbs: typeof cbs } = {
    cbs,
    watchHeading: async (cb) => {
      cbs.push(cb);
      return { remove: () => {} };
    },
    ...overrides,
  };
  return api;
}

function fakeAppState() {
  let handler: ((s: "active" | "background" | "inactive") => void) | null = null;
  let removed = false;
  const api: AppStateApi & { fire: (s: "active" | "background" | "inactive") => void; isRemoved: () => boolean } = {
    subscribe: (cb) => {
      handler = cb;
      removed = false;
      return { remove: () => { removed = true; handler = null; } };
    },
    fire: (s) => handler?.(s),
    isRemoved: () => removed,
  };
  return api;
}

function makeController(opts: {
  loc?: Partial<LocationApi>;
  head?: Partial<HeadingApi>;
} = {}) {
  const locApi = fakeLocationApi(opts.loc);
  const headApi = fakeHeadingApi(opts.head);
  const appState = fakeAppState();
  const recorder = new DiagnosticsRecorder(true);
  const controller = new FieldSessionController({
    location: new LocationService(locApi),
    heading: new HeadingService(headApi),
    recorder,
    appState,
  });
  return { controller, locApi, headApi, appState, recorder };
}

// ── 1. State machine table (spec Part 4) ────────────────────────────────────
describe("transition table", () => {
  test("every legal transition from the spec table", () => {
    expect(transition(snap("idle"), ev("START"))!.state).toBe("requestingPermissions");
    expect(transition(snap("requestingPermissions"), { type: "PERM_GRANTED", precise: true })!.state).toBe("starting");
    expect(transition(snap("requestingPermissions"), ev("PERM_DENIED"))).toMatchObject({ state: "error", errorCode: "permission" });
    expect(transition(snap("requestingPermissions"), ev("SERVICES_OFF"))).toMatchObject({ state: "error", errorCode: "services" });
    expect(transition(snap("starting"), ev("FIRST_FIX_OK"))!.state).toBe("active");
    expect(transition(snap("starting"), ev("FIRST_FIX_TIMEOUT"))).toMatchObject({ state: "error", errorCode: "no-gps" });
    expect(transition(snap("active"), ev("PAUSE_USER"))).toMatchObject({ state: "paused", pausedBy: "user" });
    expect(transition(snap("active"), ev("APP_BACKGROUND"))).toMatchObject({ state: "paused", pausedBy: "system" });
    expect(transition(snap("paused", "user"), ev("RESUME_USER"))!.state).toBe("active");
    expect(transition(snap("paused", "system"), ev("RESUME_USER"))!.state).toBe("active");
    expect(transition(snap("paused", "system"), ev("APP_FOREGROUND"))!.state).toBe("active");
    expect(transition(snap("active"), ev("WATCH_FATAL"))).toMatchObject({ state: "error", errorCode: "sensor" });
    expect(transition(snap("paused", "user"), ev("WATCH_FATAL"))!.state).toBe("error");
    for (const s of ["requestingPermissions", "starting", "active", "paused", "error"] as const) {
      expect(transition(snap(s), ev("STOP"))!.state).toBe("stopping");
    }
    expect(transition(snap("stopping"), ev("CLEANUP_DONE"))!.state).toBe("idle");
    expect(transition(snap("error"), ev("RETRY"))!.state).toBe("requestingPermissions");
    expect(transition(snap("error"), ev("DISMISS"))!.state).toBe("idle");
  });

  test("user-pause WINS over foregrounding (spec rule)", () => {
    expect(transition(snap("paused", "user"), ev("APP_FOREGROUND"))).toBeNull();
  });

  test("stopping is uninterruptible except CLEANUP_DONE", () => {
    for (const t of ["START", "PAUSE_USER", "RESUME_USER", "STOP", "RETRY", "DISMISS", "APP_BACKGROUND", "APP_FOREGROUND"] as const) {
      expect(transition(snap("stopping"), ev(t))).toBeNull();
    }
  });

  test("illegal commands are rejected (null), not coerced", () => {
    expect(transition(snap("idle"), ev("PAUSE_USER"))).toBeNull();
    expect(transition(snap("idle"), ev("STOP"))).toBeNull();
    expect(transition(snap("active"), ev("START"))).toBeNull();
    expect(transition(snap("active"), ev("RESUME_USER"))).toBeNull();
    expect(transition(snap("active"), ev("APP_FOREGROUND"))).toBeNull();
  });
});

// ── 2. LocationService (spec Part 2/7) ──────────────────────────────────────
describe("LocationService", () => {
  test("first fix: fresh ok, no last-known → one non-provisional emit", async () => {
    const svc = new LocationService(fakeLocationApi());
    const fixes: FieldFix[] = [];
    svc.onFix((f) => fixes.push(f));
    const r = await svc.acquireFirstFix(1000);
    expect(r.ok).toBe(true);
    expect(fixes).toHaveLength(1);
    expect(fixes[0].provisional).toBe(false);
    expect(fixes[0].accuracy).toBe(8);
  });

  test("first fix: provisional last-known emitted before fresh", async () => {
    const svc = new LocationService(fakeLocationApi({ lastKnown: async () => rawFix(1, 1, 30) }));
    const fixes: FieldFix[] = [];
    svc.onFix((f) => fixes.push(f));
    const r = await svc.acquireFirstFix(1000);
    expect(r.ok).toBe(true);
    expect(fixes).toHaveLength(2);
    expect(fixes[0].provisional).toBe(true);
    expect(fixes[1].provisional).toBe(false);
  });

  test("first fix: timeout returns provisional and never throws", async () => {
    const svc = new LocationService(fakeLocationApi({
      lastKnown: async () => rawFix(1, 1, 40),
      currentFix: () => new Promise<RawFix>(() => {}), // never resolves
    }));
    const r = await svc.acquireFirstFix(20);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.provisional?.provisional).toBe(true);
  });

  test("single-subscription invariant: second start is rejected", async () => {
    const api = fakeLocationApi();
    const svc = new LocationService(api);
    expect(await svc.start(WALKING_PROFILE)).toBe(true);
    expect(await svc.start(WALKING_PROFILE)).toBe(false);
    expect(svc.subscriptionCount()).toBe(1);
    svc.stop();
    expect(svc.subscriptionCount()).toBe(0);
  });

  test("no events after stop (generation guard) and stop is idempotent", async () => {
    const api = fakeLocationApi();
    const svc = new LocationService(api);
    const fixes: FieldFix[] = [];
    svc.onFix((f) => fixes.push(f));
    await svc.start();
    api.watchCbs[0](rawFix());
    expect(fixes).toHaveLength(1);
    svc.stop();
    svc.stop(); // idempotent
    api.watchCbs[0](rawFix()); // stale callback
    expect(fixes).toHaveLength(1);
  });

  test("stop during in-flight watch start removes the late subscription", async () => {
    let resolveWatch!: (s: { remove(): void }) => void;
    const removed: string[] = [];
    const api = fakeLocationApi({
      watch: () => new Promise((res) => { resolveWatch = res; }),
    });
    const svc = new LocationService(api);
    const startP = svc.start();
    svc.stop(); // wins the race
    resolveWatch({ remove: () => removed.push("late") });
    expect(await startP).toBe(false);
    expect(removed).toEqual(["late"]);
    expect(svc.subscriptionCount()).toBe(0);
  });
});

// ── 3. HeadingService (spec Part 2/6) ───────────────────────────────────────
describe("HeadingService", () => {
  test("circular math: 359°→1° averages near 0°, never 180°", () => {
    const s = circularSmooth(359, 1, 0.5);
    expect(s < 5 || s > 355).toBe(true);
    expect(angularDelta(1, 359)).toBe(2);
    expect(angularDelta(359, 1)).toBe(-2);
  });

  test("emission gate: 50 Hz input → ≤2 Hz output", async () => {
    let now = 0;
    const api = fakeHeadingApi();
    const svc = new HeadingService(api, () => now);
    let emitted = 0;
    svc.onHeading(() => emitted++);
    await svc.start();
    for (let i = 0; i < 50; i++) {
      now += 20; // 50 Hz for 1 second
      api.cbs[0]({ trueHeading: (i * 30) % 360, magHeading: (i * 30) % 360, accuracy: 3 });
    }
    expect(svc.counts().raw).toBe(50);
    expect(emitted).toBeLessThanOrEqual(3); // ≤2 Hz over ~1s (+the first)
    svc.stop();
  });

  test("delta gate: sub-3° jitter never emits twice", async () => {
    let now = 0;
    const api = fakeHeadingApi();
    const svc = new HeadingService(api, () => now);
    let emitted = 0;
    svc.onHeading(() => emitted++);
    await svc.start();
    api.cbs[0]({ trueHeading: 100, magHeading: 100, accuracy: 3 });
    now += 5000;
    api.cbs[0]({ trueHeading: 100.5, magHeading: 100.5, accuracy: 3 }); // <3° smoothed
    expect(emitted).toBe(1);
    svc.stop();
  });

  test("unavailable is non-fatal and reported", async () => {
    const svc = new HeadingService({ watchHeading: async () => { throw new Error("no magnetometer"); } });
    let unavailable = false;
    svc.onUnavailable(() => { unavailable = true; });
    expect(await svc.start()).toBe(false);
    expect(svc.getStatus()).toBe("unavailable");
    expect(unavailable).toBe(true);
  });

  test("trueHeading < 0 falls back to magnetic", async () => {
    let now = 0;
    const api = fakeHeadingApi();
    const svc = new HeadingService(api, () => now);
    const got: number[] = [];
    svc.onHeading((h) => got.push(h.trueHeading));
    await svc.start();
    api.cbs[0]({ trueHeading: -1, magHeading: 220, accuracy: 3 });
    expect(Math.round(got[0])).toBe(220);
    svc.stop();
  });
});

// ── 4. DiagnosticsRecorder tripwire (spec Part 11.5) ────────────────────────
describe("DiagnosticsRecorder", () => {
  test("post-stop event inside the 2s window is a persistent violation", () => {
    let now = 1000;
    const rec = new DiagnosticsRecorder(true, () => now);
    rec.sessionStarted();
    rec.armTripwire();
    now += 500;
    rec.fix({ lat: 0, lng: 0, accuracy: 5, altitude: null, speed: null, timestamp: now, provisional: false });
    expect(rec.tripwireStatus().violated).toBe(true);
    const audit = rec.audit([]);
    expect(audit.pass).toBe(false);
  });

  test("clean stop audits pass", () => {
    let now = 1000;
    const rec = new DiagnosticsRecorder(true, () => now);
    rec.sessionStarted();
    rec.armTripwire();
    now += 5000; // outside window — nothing arrived
    const audit = rec.audit([{ name: "x", pass: true }]);
    expect(audit.pass).toBe(true);
  });
});

// ── 5. Controller integration with fakes (spec Parts 3/5/7/9) ───────────────
describe("FieldSessionController", () => {
  test("happy path: idle → active with sensors running", async () => {
    const { controller } = makeController();
    controller.start();
    await flush();
    const s = controller.getSnapshot();
    expect(s.machine.state).toBe("active");
    expect(s.lastFix).not.toBeNull();
    expect(controller.subscriptionCounts()).toEqual({ position: 1, heading: 1, appState: 1 });
  });

  test("permission denied → error(permission)", async () => {
    const { controller } = makeController({
      loc: { requestPermissions: async () => ({ granted: false, preciseGranted: false, canAskAgain: false }) },
    });
    controller.start();
    await flush();
    expect(controller.getSnapshot().machine).toMatchObject({ state: "error", errorCode: "permission" });
  });

  test("services disabled → error(services)", async () => {
    const { controller } = makeController({ loc: { servicesEnabled: async () => false } });
    controller.start();
    await flush();
    expect(controller.getSnapshot().machine).toMatchObject({ state: "error", errorCode: "services" });
  });

  test("approximate-only grant sets degradedAccuracy but continues", async () => {
    const { controller } = makeController({
      loc: { requestPermissions: async () => ({ granted: true, preciseGranted: false, canAskAgain: true }) },
    });
    controller.start();
    await flush();
    const s = controller.getSnapshot();
    expect(s.machine.state).toBe("active");
    expect(s.degradedAccuracy).toBe(true);
  });

  test("pause/resume matrix incl. user-pause wins over foreground", async () => {
    const { controller, appState } = makeController();
    controller.start();
    await flush();

    controller.pause(); // user
    expect(controller.getSnapshot().machine).toMatchObject({ state: "paused", pausedBy: "user" });
    expect(controller.subscriptionCounts().position).toBe(0);
    appState.fire("active"); // foreground must NOT resume a user pause
    expect(controller.getSnapshot().machine.state).toBe("paused");
    controller.resume();
    await flush();
    expect(controller.getSnapshot().machine.state).toBe("active");

    appState.fire("background"); // system pause
    expect(controller.getSnapshot().machine).toMatchObject({ state: "paused", pausedBy: "system" });
    appState.fire("active"); // auto-resume
    await flush();
    expect(controller.getSnapshot().machine.state).toBe("active");
  });

  test("stop: full cleanup, audit pass, no post-stop events", async () => {
    const { controller, locApi, recorder, appState } = makeController();
    controller.start();
    await flush();
    controller.stop();
    const s = controller.getSnapshot();
    expect(s.machine.state).toBe("idle");
    expect(controller.subscriptionCounts()).toEqual({ position: 0, heading: 0, appState: 0 });
    expect(appState.isRemoved()).toBe(true);
    expect(recorder.getLastAudit()?.pass).toBe(true);
    // Stale sensor callback after stop must be swallowed by the generation guard.
    locApi.watchCbs.forEach((cb) => cb(rawFix()));
    expect(recorder.tripwireStatus().violated).toBe(false);
    expect(controller.getSnapshot().fixCount).toBe(s.fixCount);
  });

  test("10 rapid start/stop cycles: identical clean end state every time", async () => {
    const { controller, recorder } = makeController();
    for (let i = 0; i < 10; i++) {
      controller.start();
      await flush();
      expect(controller.getSnapshot().machine.state).toBe("active");
      controller.stop();
      expect(controller.getSnapshot().machine.state).toBe("idle");
      expect(controller.subscriptionCounts()).toEqual({ position: 0, heading: 0, appState: 0 });
    }
    expect(recorder.getCounters().startStopCycles).toBe(10);
  });

  test("watch failure: one silent retry then error(sensor)", async () => {
    const { controller, recorder } = makeController({
      loc: { watch: async () => { throw new Error("provider dead"); } },
    });
    controller.start();
    await flush(12);
    expect(controller.getSnapshot().machine).toMatchObject({ state: "error", errorCode: "sensor" });
    expect(recorder.getCounters().watchRetries).toBe(1);
  });

  test("heading unavailable never blocks the session", async () => {
    const { controller } = makeController({
      head: { watchHeading: async () => { throw new Error("no compass"); } },
    });
    controller.start();
    await flush();
    const s = controller.getSnapshot();
    expect(s.machine.state).toBe("active");
    expect(s.headingSupported).toBe(false);
  });

  test("illegal commands are logged no-ops that never change state", async () => {
    const { controller, recorder } = makeController();
    controller.pause();
    controller.resume();
    controller.stop();
    controller.retry();
    expect(controller.getSnapshot().machine.state).toBe("idle");
    const ignored = recorder.getLifecycle().filter((l) => l.ignored);
    expect(ignored.length).toBeGreaterThanOrEqual(4);
  });

  test("error state: RETRY re-runs the flow to active", async () => {
    let denyFirst = true;
    const { controller } = makeController({
      loc: {
        requestPermissions: async () => {
          const granted = !denyFirst;
          denyFirst = false;
          return { granted, preciseGranted: granted, canAskAgain: true };
        },
      },
    });
    controller.start();
    await flush();
    expect(controller.getSnapshot().machine.state).toBe("error");
    controller.retry();
    await flush();
    expect(controller.getSnapshot().machine.state).toBe("active");
  });
});
