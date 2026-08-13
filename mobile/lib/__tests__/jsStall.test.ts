// The stall detector, and the reasoning it encodes.
//
// A single-threaded runtime cannot observe itself while it is blocked, so the
// measurement is necessarily retrospective: the heartbeat asks for a turn every
// TICK_MS, and the amount by which a turn arrives LATE is how long the thread was
// unavailable. These tests drive that with a fake clock, because a test that
// blocked a real thread to prove a blocked thread is detected would be measuring
// the test runner.
import {
  KEEP_STALLS, SEVERE_MS, STALL_MS, TICK_MS,
  currentPhases, markPhase, resetStalls, stallReport, startStallWatch,
} from "../diagnostics/jsStall";

describe("phases attribute a stall to the work that caused it", () => {
  beforeEach(() => resetStalls());

  test("a phase is open until it is ended", () => {
    const end = markPhase("pack.require");
    expect(currentPhases()).toEqual(["pack.require"]);
    end();
    expect(currentPhases()).toEqual([]);
  });

  test("phases nest, outermost first", () => {
    const outer = markPhase("app.boot");
    const inner = markPhase("pack.require");
    expect(currentPhases()).toEqual(["app.boot", "pack.require"]);
    inner();
    expect(currentPhases()).toEqual(["app.boot"]);
    outer();
  });

  test("an inner phase that forgets to end does not unwind an outer one", () => {
    // Removed by identity rather than popped. Otherwise one missing `finally`
    // silently reattributes every later stall to the wrong component.
    const outer = markPhase("app.boot");
    markPhase("pack.require"); // never ended
    outer();
    expect(currentPhases()).toEqual(["pack.require"]);
  });

  test("ending twice is harmless", () => {
    const end = markPhase("pack.read");
    end();
    end();
    expect(currentPhases()).toEqual([]);
  });
});

describe("detecting a thread that was not answering", () => {
  beforeEach(() => { jest.useFakeTimers(); resetStalls(); });
  afterEach(() => { jest.useRealTimers(); });

  /** A clock we move by hand, so a "block" is a jump rather than a wait. */
  function clock(start = 0) {
    let t = start;
    return { now: () => t, advance: (ms: number) => { t += ms; } };
  }

  test("an on-time heartbeat reports nothing", () => {
    const c = clock();
    const stop = startStallWatch({ now: c.now });
    for (let i = 0; i < 10; i++) { c.advance(TICK_MS); jest.advanceTimersByTime(TICK_MS); }
    expect(stallReport().count).toBe(0);
    stop();
  });

  test("ordinary scheduling noise is not a stall", () => {
    // A dropped frame or two on a mid-range phone is not something to wake
    // anybody about. Only an overshoot a person would notice counts.
    const c = clock();
    const stop = startStallWatch({ now: c.now });
    c.advance(TICK_MS + STALL_MS - 1);
    jest.advanceTimersByTime(TICK_MS);
    expect(stallReport().count).toBe(0);
    stop();
  });

  test("a blocked thread is caught, with its duration", () => {
    const c = clock();
    const stop = startStallWatch({ now: c.now });
    // The thread disappears for four seconds — the pack load, on a slow phone.
    c.advance(TICK_MS + 4000);
    jest.advanceTimersByTime(TICK_MS);

    const r = stallReport();
    expect(r.count).toBe(1);
    expect(r.stalls[0].durationMs).toBe(4000);
    expect(r.worstMs).toBe(4000);
    stop();
  });

  test("the stall arrives ALREADY ATTRIBUTED to the open phases", () => {
    // This is the whole point. "Something took four seconds" leaves the hunt
    // where it started; "pack.require took four seconds" ends it.
    const c = clock();
    const stop = startStallWatch({ now: c.now });
    const boot = markPhase("app.boot");
    const req = markPhase("pack.require");

    c.advance(TICK_MS + 3000);
    jest.advanceTimersByTime(TICK_MS);

    expect(stallReport().stalls[0].phases).toEqual(["app.boot", "pack.require"]);
    req(); boot(); stop();
  });

  test("a stall with nothing declared still reports, so it cannot hide", () => {
    const c = clock();
    const stop = startStallWatch({ now: c.now });
    c.advance(TICK_MS + 2000);
    jest.advanceTimersByTime(TICK_MS);
    expect(stallReport().stalls[0].phases).toEqual([]);
    stop();
  });

  test("severe stalls are distinguishable from slow ones", () => {
    expect(SEVERE_MS).toBeGreaterThan(STALL_MS);
  });

  test("the log is bounded — a field session cannot grow it without end", () => {
    const c = clock();
    const stop = startStallWatch({ now: c.now });
    for (let i = 0; i < KEEP_STALLS + 20; i++) {
      c.advance(TICK_MS + 500);
      jest.advanceTimersByTime(TICK_MS);
    }
    expect(stallReport().count).toBe(KEEP_STALLS);
    stop();
  });

  test("a second watcher is a no-op — two heartbeats would report each other", () => {
    const c = clock();
    const stop = startStallWatch({ now: c.now });
    const second = startStallWatch({ now: c.now });
    c.advance(TICK_MS + 2000);
    jest.advanceTimersByTime(TICK_MS);
    expect(stallReport().count).toBe(1);
    second(); stop();
  });

  test("stopping ends the watch", () => {
    const c = clock();
    const stop = startStallWatch({ now: c.now });
    stop();
    c.advance(TICK_MS + 5000);
    jest.advanceTimersByTime(TICK_MS);
    expect(stallReport().count).toBe(0);
  });
});
