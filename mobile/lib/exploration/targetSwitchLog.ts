// Every time the navigation destination changes, and why.
//
// Written because a geologist reported the app ping-ponging between two targets
// on a drive, and nothing in the system could say what had happened. The
// destination was a value recomputed from a ranking, so a switch left no trace —
// there was nothing to read afterwards, on the device or in a test.
//
// Two outlets, on purpose:
//   · console, prefixed TARGET_SWITCH_EVENT, so `adb logcat | grep
//     TARGET_SWITCH_EVENT` shows a live drive
//   · a ring buffer, so a test can drive a synthetic route and assert on the
//     sequence rather than on a screenshot
//
// "kept" is logged too. A log that only records switches cannot distinguish "the
// target held" from "nothing ran at all", and that difference is the whole
// question here.

/** What caused the re-evaluation. Not the same thing as why the target changed. */
export type TargetSwitchTrigger =
  | "user-selected"
  | "gps-cell-change"
  | "refresh"
  | "evidence"
  | "commodity"
  | "inspect"
  | "session-start";

/** Why the destination ended up where it did. */
export type TargetSwitchReason =
  /** There was no target before this. */
  | "first-target"
  /** The destination did not move. */
  | "kept"
  /** The user chose it. */
  | "user-selected"
  /**
   * The old target was no longer in the ranked list.
   *
   * With `limit: 3` and a k-ring recentred on every cell change, a target can
   * leave the list without its own score changing at all — other cells enter the
   * ring ahead of the traveller and the distance tie-break reorders them.
   */
  | "dropped-from-ranking"
  /**
   * The old target WAS the cell the user had just entered.
   *
   * `rank()` excludes the current cell from its candidates, so a target removes
   * itself from the running the moment you arrive in its cell — which at H3
   * resolution 7 is up to ~1.2 km from its centre, while the arrival radius is
   * 25–150 m. In that gap the app has no target and hands out a different one.
   */
  | "self-excluded-current-cell"
  /** Ranking produced nothing worth walking to. */
  | "no-targets"
  /** The old target was cleared deliberately (session end, inspect, commodity). */
  | "released";

export interface TargetSwitchEvent {
  at: number;
  trigger: TargetSwitchTrigger;
  reason: TargetSwitchReason;
  oldTarget: string | null;
  newTarget: string | null;
  distanceOldM: number | null;
  distanceNewM: number | null;
  /** The cell the user was in when this was decided — the other half of the story. */
  fromCell: string | null;
  /** The ranked list at the moment of the decision, best first. */
  ranked: string[];
}

/** Bounded so a long traverse cannot grow without limit. */
const MAX_EVENTS = 200;
const buffer: TargetSwitchEvent[] = [];

export function recordTargetSwitch(e: TargetSwitchEvent): void {
  buffer.push(e);
  if (buffer.length > MAX_EVENTS) buffer.shift();
  // One line, greppable, with the numbers that decide whether a switch was sane.
  // eslint-disable-next-line no-console
  console.log(
    `TARGET_SWITCH_EVENT reason=${e.reason} trigger=${e.trigger} ` +
    `oldTarget=${e.oldTarget ?? "-"} newTarget=${e.newTarget ?? "-"} ` +
    `distanceOld=${e.distanceOldM == null ? "-" : Math.round(e.distanceOldM) + "m"} ` +
    `distanceNew=${e.distanceNewM == null ? "-" : Math.round(e.distanceNewM) + "m"} ` +
    `fromCell=${e.fromCell ?? "-"} ranked=[${e.ranked.join(",")}]`,
  );
}

export function targetSwitchLog(): readonly TargetSwitchEvent[] {
  return buffer;
}

export function clearTargetSwitchLog(): void {
  buffer.length = 0;
}

/** Switches that actually moved the destination. */
export function actualSwitches(
  log: readonly TargetSwitchEvent[] = buffer,
): readonly TargetSwitchEvent[] {
  return log.filter((e) => e.oldTarget != null && e.newTarget != null && e.oldTarget !== e.newTarget);
}
