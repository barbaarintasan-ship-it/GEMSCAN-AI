// What is nearest — measured from the pack, at any distance.
//
// WHY THIS IS SEPARATE FROM TARGETING
// -----------------------------------
// Targeting answers "where should I walk?" and refuses to answer beyond 15 km,
// which is correct: a recommendation to walk 94 km is not a recommendation.
// But refusing to RECOMMEND is not the same as having nothing to SAY, and the
// app was conflating the two. Standing near Bosaso it found no target, no fault
// within 25 km, no occurrence within 50 km and no DEM cell within 5 km, so it
// showed an empty screen and the word "orienting" — while the pack knew
// perfectly well that the nearest mapped occurrence was 94 km to the south-west.
//
// This module answers the weaker, always-answerable question: what is the
// nearest thing you know about, how far, and in which direction. Every field is
// a measurement over pack contents. Nothing here estimates, and when the pack
// holds nothing the answer is null rather than a guess.
import { haversineM, bearingDeg, pointToPolylineM } from "../../../shared/geo-core/geo/spatial.ts";
import type { PackData } from "../../../shared/geo-core/pack/types.ts";

/** Within these, a feature is "nearby" — worth listing as evidence for here. */
export const NEARBY_FAULT_M = 25_000;
export const NEARBY_OCCURRENCE_M = 50_000;
/** Past this the nearest sampled DEM cell no longer describes this ground. */
export const ELEVATION_MAX_M = 5_000;

export interface NearestFault {
  distanceM: number;
  bearingDeg: number;
  name: string | null;
}

export interface NearestOccurrence {
  distanceM: number;
  bearingDeg: number;
  commodity: string | null;
  name: string | null;
}

export interface Orientation {
  fault: NearestFault | null;
  occurrence: NearestOccurrence | null;
  /** Elevation at the nearest sampled cell, only when that cell is close enough. */
  elevationM: number | null;
  /** How far the elevation reading came from, so the screen can qualify it. */
  elevationFromM: number | null;
  /** True when nothing at all is within the "nearby" thresholds. */
  nothingNearby: boolean;
}

/**
 * The point on a polyline closest to `at`.
 *
 * Needed for DIRECTION only. The shared `pointToPolylineM` returns how far the
 * line is but not where, and the obvious substitute — the nearest vertex — is
 * not good enough: on a straight fault with vertices 20 km apart the nearest
 * vertex can sit 14 degrees off the nearest point, which is a whole compass
 * point. Someone told "east" who should have been told "east-north-east" walks
 * the wrong way, so the projection is done properly.
 *
 * Local equirectangular frame with longitude scaled by cos(lat). Over the few
 * hundred kilometres this is ever asked about, that is well within the accuracy
 * of a compass point. It is not used for distance — that still comes from the
 * shared function, so this can never disagree with targeting about how far a
 * fault is.
 */
function closestPointOn(
  at: { lat: number; lng: number },
  line: ReadonlyArray<readonly [number, number]>,
): { lat: number; lng: number } | null {
  if (line.length === 0) return null;
  if (line.length === 1) return { lng: line[0][0], lat: line[0][1] };

  const k = Math.cos((at.lat * Math.PI) / 180);
  const px = at.lng * k;
  const py = at.lat;

  let bestD2 = Infinity;
  let best: { lat: number; lng: number } | null = null;

  for (let i = 1; i < line.length; i++) {
    const ax = line[i - 1][0] * k, ay = line[i - 1][1];
    const bx = line[i][0] * k, by = line[i][1];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    // A zero-length segment is its own closest point; clamping keeps the
    // parameter on the segment rather than running off the end of the fault.
    const tRaw = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
    const t = Math.max(0, Math.min(1, tRaw));
    const cx = ax + t * dx, cy = ay + t * dy;
    const d2 = (px - cx) ** 2 + (py - cy) ** 2;
    if (d2 < bestD2) {
      bestD2 = d2;
      best = { lat: cy, lng: cx / k };
    }
  }
  return best;
}

/**
 * Nearest mapped fault.
 *
 * Distance is measured with the shared `pointToPolylineM`, the same measure
 * targeting uses, so the two can never disagree about how far a fault is.
 * Direction points at the closest point on that same line.
 */
export function nearestFault(
  data: PackData,
  at: { lat: number; lng: number },
): NearestFault | null {
  let bestD = Infinity;
  let best: { name: string | null; vertex: { lat: number; lng: number } } | null = null;

  for (const f of data.mapFeatures) {
    if (f.kind !== "fault") continue;
    for (const line of f.lines) {
      const d = pointToPolylineM(at, line);
      if (d >= bestD) continue;
      const nearest = closestPointOn(at, line);
      if (!nearest) continue;
      bestD = d;
      best = { name: f.name ?? null, vertex: nearest };
    }
  }

  if (!best || !Number.isFinite(bestD)) return null;
  return { distanceM: bestD, bearingDeg: bearingDeg(at, best.vertex), name: best.name };
}

/** Nearest known mineral occurrence, at any distance. */
export function nearestOccurrence(
  data: PackData,
  at: { lat: number; lng: number },
): NearestOccurrence | null {
  let best: NearestOccurrence | null = null;
  for (const o of data.occurrences) {
    const d = haversineM(at, { lat: o.lat, lng: o.lng });
    if (best && d >= best.distanceM) continue;
    best = {
      distanceM: d,
      bearingDeg: bearingDeg(at, { lat: o.lat, lng: o.lng }),
      commodity: o.commodity_key,
      name: o.name ?? null,
    };
  }
  return best;
}

/**
 * Elevation at the nearest sampled terrain cell.
 *
 * Returns the distance it came from alongside the value, so the caller can
 * decide whether to show it. A DEM sample 90 km away says nothing about the
 * ground underfoot, and presenting it unqualified would be a fabrication.
 */
export function elevationAt(
  data: PackData,
  at: { lat: number; lng: number },
): { elevationM: number; fromM: number } | null {
  let best: number | null = null;
  let bestD = Infinity;
  for (const t of data.terrain) {
    const d = haversineM(at, { lat: t.lat, lng: t.lng });
    if (d < bestD) { bestD = d; best = t.elevationM; }
  }
  return best == null ? null : { elevationM: best, fromM: bestD };
}

/** Everything the pack can say about a point, near or far. */
export function orientationAt(data: PackData, at: { lat: number; lng: number }): Orientation {
  const fault = nearestFault(data, at);
  const occurrence = nearestOccurrence(data, at);
  const elev = elevationAt(data, at);
  const withinElev = elev != null && elev.fromM <= ELEVATION_MAX_M;

  return {
    fault,
    occurrence,
    elevationM: withinElev ? elev!.elevationM : null,
    elevationFromM: elev?.fromM ?? null,
    nothingNearby:
      (fault == null || fault.distanceM > NEARBY_FAULT_M) &&
      (occurrence == null || occurrence.distanceM > NEARBY_OCCURRENCE_M) &&
      !withinElev,
  };
}

/**
 * A view radius that actually contains something.
 *
 * The map defaults to a 12 km half-width because that is a walkable
 * neighbourhood. Where the pack has nothing that close the result is a blank
 * rectangle, which reads as a broken map rather than as empty ground. Widening
 * to include the nearest known feature keeps the map informative without
 * inventing anything: the same features are drawn, and the scale bar states the
 * new scale. Capped, because past a few hundred kilometres the viewer's own
 * position stops being locatable on it.
 */
export function fittingRadiusM(
  o: Orientation,
  defaultM: number,
  maxM = 400_000,
): number {
  const candidates = [o.fault?.distanceM, o.occurrence?.distanceM].filter(
    (d): d is number => typeof d === "number" && Number.isFinite(d),
  );
  if (candidates.length === 0) return defaultM;
  const nearest = Math.min(...candidates);
  if (nearest <= defaultM) return defaultM;
  // A margin so the feature is inside the frame rather than on its edge.
  return Math.min(maxM, nearest * 1.25);
}
