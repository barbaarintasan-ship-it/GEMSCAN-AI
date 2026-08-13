// Keeping the screen on while a traverse is running.
//
// WHY THIS EXISTS — three reported faults, one cause.
//
//   "the app opens frozen, it scrolls but no button responds"
//   "GPS is not working — 703 seconds with no new position, outdoors, clear sky"
//   "I reach the target and nothing happens, it just says keep going"
//
// All three are the phone going to sleep.
//
// Android stops scheduling a backgrounded process. `expo-location`'s watch
// delivers each fix through a JavaScript callback, so with the screen off the
// fixes stop arriving — not because the receiver lost the sky, but because
// nothing is running to receive them. The app then reports the position as
// STALE, which is honest and completely mystifying to someone standing outside
// looking at satellites.
//
// Arrival is judged on each fix (see orchestrator: `inTargetCell || toCentreM <=
// arrivalRadiusFor`). No fixes means no arrival check, which is why walking onto
// a target produced nothing at all and the guidance kept saying "keep going".
//
// And on resume the whole absence lands at once — a burst of queued work that
// looks exactly like a frozen app to anyone tapping a button during it.
//
// So: while a walk is running, the screen stays on. This is what every
// navigation app does, for this reason.
//
// WHAT IT DOES NOT DO
//
// It does not override the POWER BUTTON. `activateKeepAwake` only prevents the
// idle timeout; pressing the button still locks the phone, which is correct —
// the geologist must be able to put it away deliberately, and an app that
// refuses to sleep on command is a battery complaint waiting to happen.
//
// It releases the moment the session ends, so the collection screens and the
// scanner behave exactly as before.
import { useEffect } from "react";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";

/** One tag, so a second activation cannot orphan the first. */
export const KEEP_AWAKE_TAG = "luulscan-exploration";

export function useAwakeWhileExploring(running: boolean): void {
  useEffect(() => {
    if (!running) return;
    let released = false;

    // Never fatal. A device that refuses the request is a device whose screen
    // times out — worse guidance, not a broken app — and throwing here would take
    // the map down with it.
    void activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => {});

    return () => {
      if (released) return;
      released = true;
      try {
        deactivateKeepAwake(KEEP_AWAKE_TAG);
      } catch {
        // Already released, or never granted. Either way there is nothing to undo.
      }
    };
  }, [running]);
}
