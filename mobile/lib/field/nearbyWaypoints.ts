// What has already been recorded near where you are standing.
//
// A geologist walks back into a valley they worked three weeks ago. The app knew
// about the eight photographs and the bagged sample the whole time and said
// nothing — so the panel read "No sample recorded" over ground that had one. That
// is the failure this exists to stop.
//
// CONTEXT ONLY. Nothing here reaches the prospectivity engine: no weight, no
// TYPE_SIGNAL entry, no evidence item, no path into targeting or scoring. A
// geologist's own earlier work is shown to them so they can decide what to do next;
// it is not a signal that the ground is more prospective. Scoring already counts
// field observations through `localEvidence`, once, and counting them twice here
// would inflate a site for having been visited.
//
// PURE, and offline. Takes the waypoints it is given and does arithmetic — no
// store, no clock, no network. The device's own record is the only source, so this
// works in a wadi with no signal, which is where it is needed.
import { haversineM } from "../../../shared/geo-core/geo/spatial.ts";
import type { Waypoint, WaypointSample, WaypointType } from "./waypointTypes";

/**
 * How far counts as "here".
 *
 * 250 m is a few minutes' walk and comfortably wider than a GPS fix's error, so a
 * geologist standing on the same outcrop as last time will be told about it even
 * with a poor fix on either visit.
 */
export const NEARBY_RADIUS_M = 250;

export interface NearbyWaypoint {
  id: string;
  /** Metres from the position asked about, to the recorded fix. */
  distanceM: number;
  type: WaypointType;
  /** The sample taken there, when one was. Null is the common case. */
  sample: WaypointSample | null;
  photoCount: number;
  capturedAt: number;
  /** Which investigation it belonged to, or null if it was recorded outside one. */
  missionId: string | null;
}

export interface NearbyOptions {
  /** Only this mission's evidence. Omit for everything within reach. */
  missionId?: string | null;
}

/**
 * Previous field evidence within `radiusM`, nearest first.
 *
 * Skips waypoints with no recorded position — an observation with no fix is real,
 * but it cannot be placed, and reporting it at a distance nobody measured would be
 * an invention. Skips tombstones: a deleted waypoint is deleted.
 */
export function nearbyWaypoints(
  all: readonly Waypoint[],
  position: { lat: number; lng: number },
  radiusM: number = NEARBY_RADIUS_M,
  opts: NearbyOptions = {},
): NearbyWaypoint[] {
  const out: NearbyWaypoint[] = [];
  for (const w of all) {
    if (w.deletedAt != null) continue;
    if (!w.position) continue;
    if (opts.missionId !== undefined && (w.missionId ?? null) !== (opts.missionId ?? null)) continue;

    const distanceM = haversineM(position, { lat: w.position.lat, lng: w.position.lng });
    if (distanceM > radiusM) continue;

    out.push({
      id: w.id,
      distanceM,
      type: w.type,
      sample: w.sample ?? null,
      photoCount: w.photos.length,
      capturedAt: w.capturedAt,
      missionId: w.missionId ?? null,
    });
  }
  // Nearest first, then most recent — the thing you are most likely standing on.
  out.sort((a, b) => a.distanceM - b.distanceM || b.capturedAt - a.capturedAt);
  return out;
}

/**
 * A one-line summary for the panel heading.
 *
 * Counted here rather than in the UI so the numbers a geologist reads and the
 * numbers a report carries come from one place.
 */
export function summariseNearby(near: readonly NearbyWaypoint[]): {
  count: number;
  photoCount: number;
  sampleCount: number;
  nearestM: number | null;
} {
  return {
    count: near.length,
    photoCount: near.reduce((n, w) => n + w.photoCount, 0),
    sampleCount: near.filter((w) => w.sample != null).length,
    nearestM: near.length > 0 ? near[0].distanceM : null,
  };
}
