// Catching the JavaScript thread while it is not answering.
//
// THE SYMPTOM THIS EXISTS FOR: the app opens, the screen still scrolls, and no
// button responds until it is force-closed.
//
// Those two facts together are the diagnosis, not a mystery. On Android a
// ScrollView scrolls on the NATIVE thread — it keeps moving whatever JavaScript
// is doing. A `Pressable`, on the other hand, cannot fire until JavaScript gets
// a turn. And an invisible overlay would have blocked BOTH, because a view that
// swallows a tap swallows a drag as well.
//
// So: scrolling plus dead buttons means the JS thread is busy, not that something
// is on top. This module measures exactly that.
//
// HOW IT WORKS. A timer is asked to fire every `TICK_MS`. While the thread is
// blocked the timer cannot run at all, so the moment it does run the overshoot is
// precisely how long the thread was unavailable. The stall is therefore always
// reported AFTER it ends — which is the only way a single-threaded runtime can
// report on itself.
//
// PHASES. A duration alone says "something took four seconds" and leaves the
// hunt where it started. `markPhase` names the work in progress, so a stall
// arrives already attributed. Phases nest and are recorded as a stack.
//
// Logging only. Nothing here changes what the app does.
import { AppState } from "react-native";

/** How often the heartbeat asks for a turn. */
export const TICK_MS = 50;

/**
 * The overshoot at which a late tick becomes a reportable stall.
 *
 * Below roughly this, a dropped frame or two is ordinary scheduling noise on a
 * mid-range phone. Above it, a person tapping a button has already noticed.
 */
export const STALL_MS = 250;

/** Beyond this the app is not slow, it is unresponsive. */
export const SEVERE_MS = 1000;

export interface Stall {
  /** Milliseconds the thread was unavailable. */
  durationMs: number;
  /** What was running, outermost first. Empty when nothing declared a phase. */
  phases: string[];
  at: number;
}

/**
 * Suspension is not a stall, and conflating them made the diagnostic lie.
 *
 * The first real field reading was `worst 510053 ms` — eight and a half minutes.
 * No JavaScript takes eight minutes. What actually happened is that the screen
 * went off, Android stopped scheduling the process, and the heartbeat could not
 * run. On resume the timer fired once with an overshoot of the whole absence and
 * reported it as the app being unresponsive.
 *
 * That is a false positive, and an expensive one: it buried whatever real stalls
 * were in the same log under a number nothing could ever match, and it reported
 * `unattributed` because — correctly — nothing was running.
 *
 * So the watcher now knows when it was asleep. Time spent backgrounded is
 * skipped, and the baseline is reset on resume so the first tick back measures
 * from then rather than from before the phone was put in a pocket.
 */
let suspended = false;

/** Wall clock for phase timing. Replaced only by startStallWatch's injection. */
let clock: () => number = Date.now;

/**
 * File one stall, from whichever detector found it.
 *
 * `tick`  the heartbeat noticed it was late — the thread was unavailable.
 * `phase` a named piece of work timed itself and took too long.
 *
 * The second is the one that names a cause. The first is the one that catches
 * work nobody has named yet, which is why both are kept.
 */
function record(stall: Stall, source: "tick" | "phase"): void {
  stalls.push(stall);
  if (stalls.length > KEEP_STALLS) stalls.shift();
  const where = stall.phases.length > 0 ? stall.phases.join(" › ") : "(no phase declared)";
  const level = stall.durationMs >= SEVERE_MS ? "UNRESPONSIVE" : "stall";
  // console, not a logger: this has to work in a release build on a phone in a
  // wadi, read over adb, with nothing else installed.
  console.warn(`[jsStall] ${level} ${Math.round(stall.durationMs)}ms ${source === "phase" ? "IN" : "during"}: ${where}`);
}

const phases: string[] = [];
const stalls: Stall[] = [];
let watching: ReturnType<typeof setInterval> | null = null;
let last = 0;

/**
 * How many stalls to keep. A field session must not grow a log without bound.
 *
 * Raised from 50 after the first real report came back reading exactly `50` —
 * the cap, which means the true count was unknown and the earliest stalls, the
 * ones nearest the cause, had already been dropped.
 */
export const KEEP_STALLS = 200;

/**
 * Name the work about to happen, and return a function that marks it done.
 *
 * Deliberately not a wrapper that takes a callback: the code being measured here
 * is on the startup path, and forcing it through an extra closure would change
 * the very timings being investigated.
 */
export function markPhase(name: string): () => void {
  phases.push(name);
  const startedAt = clock();
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    // TIME THE PHASE ITSELF, and this is the fix for a real hole.
    //
    // The heartbeat can only report a stall AFTER it ends — a single-threaded
    // runtime has no other way to notice. But `currentPhases()` is read at that
    // moment, so a phase that both OPENS AND CLOSES inside one blocking stretch
    // has already gone by the time anyone looks. It is invisible precisely when
    // it is the culprit.
    //
    // That is not hypothetical: two rounds of cold-start measurement reported
    // `(no phase declared)` for a four-second block while `pack.stringify` —
    // seventeen megabytes of JSON — sat right in the middle of it, opening and
    // closing between two heartbeats.
    //
    // So a phase that blocks for longer than a stall records ITSELF. No sampling,
    // no guessing: the work that took the time is the work that reports it.
    const tookMs = clock() - startedAt;
    if (tookMs >= STALL_MS) {
      record({ durationMs: tookMs, phases: [...phases], at: clock() }, "phase");
    }
    // Removed by identity, not by popping: an inner phase that forgets to end
    // must not silently unwind an outer one.
    const i = phases.lastIndexOf(name);
    if (i >= 0) phases.splice(i, 1);
  };
}

/** The phases currently open, outermost first. */
export function currentPhases(): string[] {
  return [...phases];
}

/**
 * Start watching. Returns a stop function.
 *
 * Safe to call more than once — a second call is a no-op rather than a second
 * timer, because two heartbeats would each report the other's stalls.
 */
export function startStallWatch(deps: {
  now?: () => number;
  onStall?: (s: Stall) => void;
} = {}): () => void {
  if (watching) return () => {};
  const now = deps.now ?? Date.now;
  clock = now;
  last = now();

  // The app going to sleep is not the app hanging. Without this every screen-off
  // is reported as an outage lasting as long as the phone was in a pocket.
  const appState = AppState.addEventListener("change", (next) => {
    if (next === "active") {
      // Start measuring again from NOW. The gap while asleep belongs to Android.
      last = now();
      suspended = false;
      return;
    }
    suspended = true;
  });

  watching = setInterval(() => {
    const t = now();
    const overshoot = t - last - TICK_MS;
    last = t;
    // A tick that only ran because the app woke up measures the sleep, not a
    // stall. Skipped rather than recorded — a diagnostic that cries wolf about
    // every screen-off is one nobody reads when it finally matters.
    if (suspended) return;
    if (overshoot < STALL_MS) return;

    record({ durationMs: overshoot, phases: currentPhases(), at: t }, "tick");
    deps.onStall?.(stalls[stalls.length - 1]);
  }, TICK_MS);

  return () => {
    if (watching) clearInterval(watching);
    watching = null;
    appState.remove();
  };
}

/** Everything recorded so far, newest last. */
export function stallReport(): {
  count: number; worstMs: number; totalMs: number; stalls: Stall[];
} {
  return {
    count: stalls.length,
    worstMs: stalls.reduce((m, s) => Math.max(m, s.durationMs), 0),
    totalMs: stalls.reduce((m, s) => m + s.durationMs, 0),
    stalls: [...stalls],
  };
}

/** For tests, and for a diagnostics screen that wants a clean run. */
export function resetStalls(): void {
  stalls.length = 0;
  phases.length = 0;
}
