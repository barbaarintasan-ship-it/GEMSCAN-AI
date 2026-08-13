// Sleep is not a stall, and the screen stays on while a walk is running.
//
// THE READING THAT FOUND THIS: `JS stalls 200 · worst 510053 ms`.
//
// Eight and a half minutes. No JavaScript takes eight and a half minutes. The
// phone had gone to sleep, Android had stopped scheduling the process, and the
// heartbeat fired once on resume with an overshoot covering the whole absence.
//
// That single false number did real damage: it filled the log to the cap, buried
// every genuine stall underneath it, and reported `unattributed` — correctly,
// because nothing had been running.
//
// The same suspension is the cause of the other two reports. `expo-location`
// delivers fixes through a JavaScript callback, so a suspended process receives
// none; the app then says the position is stale, and arrival — which is judged on
// each fix — is never checked, so walking onto a target does nothing at all.
import { AppState } from "react-native";
import {
  KEEP_STALLS, markPhase, STALL_MS, resetStalls, stallReport, startStallWatch,
} from "../diagnostics/jsStall";
import { KEEP_AWAKE_TAG } from "../exploration/useAwakeWhileExploring";

/** Drives the heartbeat by hand: fake timers plus a clock we control. */
function harness() {
  let clock = 1_000_000;
  const now = () => clock;
  const stop = startStallWatch({ now });
  return {
    stop,
    /** Advance the wall clock AND let the interval fire once. */
    tick(ms: number) {
      clock += ms;
      jest.advanceTimersByTime(50);
    },
    background() { emit("background"); },
    foreground() { emit("active"); },
  };
}

/** Fire an AppState change at whatever the module subscribed with. */
function emit(state: string) {
  const calls = (AppState.addEventListener as unknown as jest.Mock).mock.calls;
  for (const [event, handler] of calls) {
    if (event === "change") (handler as (s: string) => void)(state);
  }
}

describe("the watcher knows when it was asleep", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    resetStalls();
    (AppState.addEventListener as unknown as jest.Mock).mockClear?.();
  });
  afterEach(() => jest.useRealTimers());

  test("eight minutes of SLEEP is not reported as a stall", () => {
    const h = harness();
    h.background();
    h.tick(510_053);      // the phone in a pocket
    h.foreground();
    h.tick(50);           // the first ordinary tick after waking
    expect(stallReport().count).toBe(0);
    h.stop();
  });

  test("a REAL stall while awake is still reported", () => {
    // The watcher must not have been silenced. This is the case it exists for.
    const h = harness();
    h.tick(STALL_MS + 500);
    expect(stallReport().count).toBe(1);
    expect(stallReport().worstMs).toBeGreaterThanOrEqual(STALL_MS);
    h.stop();
  });

  test("the baseline resets on resume, so the FIRST tick back is clean", () => {
    // Without the reset, the tick after waking measures from before the sleep and
    // reports the whole absence — which is exactly the 510-second reading.
    const h = harness();
    h.background();
    h.tick(300_000);
    h.foreground();
    h.tick(60);
    expect(stallReport().count).toBe(0);
    h.stop();
  });

  test("the log keeps enough history to find a cause", () => {
    // It came back reading exactly 50 — the old cap — which meant the true count
    // was unknown and the earliest stalls, the ones nearest the cause, were gone.
    expect(KEEP_STALLS).toBeGreaterThanOrEqual(200);
  });
});

describe("the screen is held awake for a walk, and only for a walk", () => {
  test("one tag, so a second activation cannot orphan the first", () => {
    expect(KEEP_AWAKE_TAG).toBe("luulscan-exploration");
  });
});

describe("the cold-start path holds no WebView", () => {
  // THE FOUR SECONDS. `[jsStall] UNRESPONSIVE 4002 ms during: app.splash`,
  // measured on an SM-A165F, on every launch. A WebView handed a full HTML
  // document, created on the same thread that has to answer a tap.
  //
  // Source is read here because the invariant is structural: someone re-mounts
  // the splash, nothing fails, and the app is four seconds dead again on every
  // cold start with no test to say so.
  const layout = require("fs").readFileSync(
    require("path").join(__dirname, "..", "..", "app", "_layout.tsx"), "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  test("the root layout does not mount AnimatedSplash", () => {
    expect(layout).not.toContain("<AnimatedSplash");
    expect(layout).not.toContain("AnimatedSplash");
  });

  test("nothing else on the startup path mounts a WebView either", () => {
    expect(layout).not.toContain("WebView");
  });

  test("the native splash is still configured, so there IS one", () => {
    // Removing the animated splash must not leave a white flash. Android draws
    // this before any JavaScript runs, which is why it costs nothing.
    const app = require("../../app.json").expo;
    expect(app.splash?.image).toBeTruthy();
    expect(app.splash?.backgroundColor).toBeTruthy();
  });
});

describe("a phase that blocks reports ITSELF", () => {
  // THE HOLE THIS CLOSES. The heartbeat can only notice a stall after it ends,
  // and it reads the phase stack at that moment — so a phase that opens and
  // closes inside one blocking stretch is already gone when anyone looks.
  //
  // Two rounds of real cold-start measurement said `(no phase declared)` for a
  // four-second block. The instrumentation was reporting what was OPEN, not what
  // had been RUNNING, and the work that took the time was invisible for exactly
  // as long as it was the culprit.
  beforeEach(() => { jest.useFakeTimers(); resetStalls(); });
  afterEach(() => jest.useRealTimers());

  test("slow work names itself, with no heartbeat involved", () => {
    let clock = 5_000_000;
    const stop = startStallWatch({ now: () => clock });

    const done = markPhase("pack.stringify");
    clock += 4_000;          // the work blocks for four seconds
    done();                  // …and closes before any tick could observe it

    const r = stallReport();
    expect(r.count).toBe(1);
    expect(r.stalls[0].phases).toContain("pack.stringify");
    expect(r.stalls[0].durationMs).toBeGreaterThanOrEqual(4_000);
    stop();
  });

  test("fast work stays silent", () => {
    let clock = 5_000_000;
    const stop = startStallWatch({ now: () => clock });
    const done = markPhase("cheap");
    clock += 5;
    done();
    expect(stallReport().count).toBe(0);
    stop();
  });

  test("the innermost work is named, with its parents for context", () => {
    let clock = 5_000_000;
    const stop = startStallWatch({ now: () => clock });
    const outer = markPhase("app.boot");
    const inner = markPhase("pack.read");
    clock += 3_000;
    inner();
    outer();
    // Both are reported — the parent also exceeded the threshold — and the first
    // to close is the one that actually did the work.
    const r = stallReport();
    expect(r.stalls[0].phases).toEqual(["app.boot", "pack.read"]);
    stop();
  });

  test("ending twice records once", () => {
    let clock = 5_000_000;
    const stop = startStallWatch({ now: () => clock });
    const done = markPhase("slow");
    clock += 2_000;
    done();
    done();
    expect(stallReport().count).toBe(1);
    stop();
  });
});

describe("the first scoring pass waits for the app to be on screen", () => {
  // `UNRESPONSIVE 4145 ms IN: field.fix › explore.onFix › explore.retarget`,
  // measured on an SM-A165F. A cold start with an open expedition resumes the
  // walk, the first fix lands about a second later, and the whole pass — pack
  // materialised, scene built, targets ranked — runs on the thread that has to
  // answer the geologist's first tap.
  //
  // Deferring changes WHEN, never WHAT. These pin that the seam exists and that
  // omitting it keeps the old behaviour exactly.
  const src = require("fs").readFileSync(
    require("path").join(__dirname, "..", "exploration", "orchestrator.ts"), "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  test("only the FIRST pass is deferred", () => {
    expect(src).toContain("hasScored");
    expect(src).toMatch(/if \(!this\.hasScored && this\.deps\.deferFirstRun\)/);
  });

  test("the flag is set BEFORE deferring, so a second fix cannot queue a second", () => {
    const block = src.slice(src.indexOf("!this.hasScored"), src.indexOf("!this.hasScored") + 400);
    expect(block.indexOf("this.hasScored = true")).toBeLessThan(block.indexOf("deferFirstRun("));
  });

  test("with no scheduler injected the behaviour is unchanged", () => {
    // The orchestrator must stay usable — and synchronous — with no React Native
    // anywhere near it. Every existing test relies on that.
    expect(src).toContain("deferFirstRun?:");
    expect(src).toMatch(/\} else \{[\s\S]{0,120}void this\.retarget\(false, "gps-cell-change"\)/);
  });

  test("the orchestrator imports nothing from react-native", () => {
    expect(src).not.toContain('from "react-native"');
  });
});
