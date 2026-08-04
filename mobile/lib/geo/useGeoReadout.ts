// Everything the pack can say about where you are — computed off the map's back.
//
// Two separate problems, one hook.
//
// THE FIRST is that `orientationAt` and `regionalTargets` both walk the whole
// pack: every occurrence, every vertex of every fault. That is a few hundred
// thousand distance calculations, and it was being run inside a `useMemo` keyed
// on the GPS fix — so it fired on every position update, on the JS thread, while
// the geologist was dragging the map. The scene does not change when you shuffle
// two metres, and neither does the answer.
//
// So the readout is gated on MOVEMENT, not on fixes, and it is computed after
// interactions have settled rather than during a gesture. Panning the map stays
// smooth because nothing heavy is competing for the thread while a finger is
// down.
//
// THE SECOND is that the two questions were never asked together even though
// they share a scan and an answer: "what is near me" and "what is worth
// travelling to". Splitting them meant the screen could conclude there was
// nothing to walk to while holding, in the same pass, the coordinates of the
// nearest gold occurrence.
//
// NOTHING HERE COMPUTES GEOLOGY. It schedules two existing pure functions and
// caches their results. Both measure over the installed pack and neither
// estimates.
import { useEffect, useRef, useState } from "react";
import { InteractionManager } from "react-native";
import { haversineM } from "../../../shared/geo-core/geo/spatial.ts";
import type { PackData } from "../../../shared/geo-core/pack/types.ts";
import { orientationAt, type Orientation } from "./orientation";
import { regionalTargets, type RegionalTarget } from "./expedition";

/**
 * How far the geologist must move before the readout is worth recomputing.
 *
 * 250 m is well inside the smallest band the screen distinguishes (500 m,
 * "immediate"), so a distance can never be one band out of date. It is also far
 * enough that a stationary phone's GPS wander — which is tens of metres, not
 * hundreds — cannot trigger a rescan of the whole pack while nobody is walking.
 */
export const RECOMPUTE_MOVE_M = 250;

/** How many regional leads to carry. A list nobody scrolls is not a list. */
const REGIONAL_LIMIT = 8;

export interface GeoReadout {
  /** The point these answers are about — NOT necessarily the current fix. */
  at: { lat: number; lng: number } | null;
  orientation: Orientation | null;
  /**
   * Mapped features worth travelling to, at any distance, best first.
   *
   * Empty means the pack genuinely holds nothing, which is a real answer. It
   * does not mean "too far".
   */
  regional: RegionalTarget[];
  /** True while the first scan for a new area is still pending. */
  computing: boolean;
}

const EMPTY: GeoReadout = { at: null, orientation: null, regional: [], computing: false };

export function useGeoReadout(
  data: PackData,
  ready: boolean,
  at: { lat: number; lng: number } | null,
  /** Distances the local targeting engine already covers, so leads aren't doubled. */
  minRegionalDistanceM = 0,
): GeoReadout {
  const [readout, setReadout] = useState<GeoReadout>(EMPTY);
  /**
   * The point a scan has been REQUESTED for — set when the work is scheduled,
   * not when it finishes.
   *
   * This distinction is the whole reliability of the hook. Gating on the
   * COMPLETED point instead looks equivalent and starves: React runs an effect's
   * cleanup on every dependency change, so with a fix arriving each second the
   * pending scan was cancelled and rescheduled before it could ever record a
   * result, and the gate it was supposed to arm never armed. Walking with a good
   * receiver was the worst case, which is precisely the case that matters.
   */
  const requestedFor = useRef<{ lat: number; lng: number } | null>(null);
  // Only a real unmount invalidates a scan in flight. A newer fix does not: it
  // is describing ground the pending answer already covers, or the gate below
  // would have let it through.
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  useEffect(() => {
    if (!ready || !at) {
      requestedFor.current = null;
      setReadout((prev) => (prev === EMPTY ? prev : EMPTY));
      return;
    }

    const prev = requestedFor.current;
    // Already asked about this ground. The gate is on the answer's point rather
    // than the last fix, so a slow drift of 249 m repeated ten times still
    // recomputes once it has actually gone somewhere.
    if (prev && haversineM(prev, at) < RECOMPUTE_MOVE_M) return;

    const point = { lat: at.lat, lng: at.lng };
    requestedFor.current = point;
    setReadout((r) => ({ ...r, computing: true }));

    // After interactions, never during one: this is the work that was making the
    // map stutter, and it is never so urgent that it must land mid-gesture.
    InteractionManager.runAfterInteractions(() => {
      // A scan superseded by a genuinely different point is dropped on arrival
      // rather than being cancelled in flight — same saving, no starvation.
      if (!mounted.current || requestedFor.current !== point) return;
      const orientation = orientationAt(data, point);
      const regional = regionalTargets(data, point, {
        limit: REGIONAL_LIMIT,
        minDistanceM: minRegionalDistanceM,
      });
      if (!mounted.current || requestedFor.current !== point) return;
      setReadout({ at: point, orientation, regional, computing: false });
    });
  }, [ready, data, at?.lat, at?.lng, minRegionalDistanceM]); // eslint-disable-line react-hooks/exhaustive-deps

  return readout;
}
