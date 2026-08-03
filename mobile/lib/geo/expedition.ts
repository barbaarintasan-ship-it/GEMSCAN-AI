// Distance is a CLASSIFICATION, never a rejection.
//
// The engine ranks what is within walking range and stops there, which is right
// for choosing the next step of a traverse and wrong as the whole answer. Most
// of Somalia has nothing mapped within 15 km, so the screen kept arriving at
// "nothing to walk to" — a dead end presented as a conclusion, while the pack
// knew perfectly well that the nearest gold occurrence was 94 km south-west.
//
// Explorers have vehicles. A target 90 km away is not unreachable; it is a
// day's drive, and saying so is guidance. So nothing here filters by distance.
// It sorts targets into bands, says how long each would take and how to get
// there, and leaves the decision where it belongs.
//
// NOTHING HERE INVENTS GEOLOGY. Every regional target is a real record in the
// knowledge pack — a mapped occurrence or a mapped fault — and its distance and
// bearing are measured, not estimated.
import { haversineM, bearingDeg, compassPoint, pointToPolylineM } from "../../../shared/geo-core/geo/spatial.ts";
import type { PackData } from "../../../shared/geo-core/pack/types.ts";

export type TargetBand = "immediate" | "local" | "regional" | "expedition";
export type Transport = "walk" | "walk_or_drive" | "vehicle" | "expedition";

export interface DistanceClass {
  band: TargetBand;
  transport: Transport;
  /** Minutes, for the recommended transport. Null when it cannot be honestly estimated. */
  travelMinutes: number | null;
}

/**
 * Speeds used for the travel estimate, in km/h.
 *
 * Deliberately pessimistic. Walking is 4 km/h on a road and nothing like that
 * across a boulder field, and "vehicle" in this country means unsealed track
 * far more often than tarmac. An estimate that flatters the journey is worse
 * than none: someone plans a return trip around it.
 */
export const WALK_KMH = 4;
export const VEHICLE_KMH = 35;

export const BAND_LIMITS_M = {
  immediate: 500,
  local: 5_000,
  regional: 50_000,
} as const;

export function classifyDistance(distanceM: number): DistanceClass {
  if (!Number.isFinite(distanceM) || distanceM < 0) {
    return { band: "immediate", transport: "walk", travelMinutes: null };
  }

  const km = distanceM / 1000;
  const walkMin = Math.round((km / WALK_KMH) * 60);
  const driveMin = Math.round((km / VEHICLE_KMH) * 60);

  if (distanceM <= BAND_LIMITS_M.immediate) {
    return { band: "immediate", transport: "walk", travelMinutes: walkMin };
  }
  if (distanceM <= BAND_LIMITS_M.local) {
    return { band: "local", transport: "walk_or_drive", travelMinutes: walkMin };
  }
  if (distanceM <= BAND_LIMITS_M.regional) {
    return { band: "regional", transport: "vehicle", travelMinutes: driveMin };
  }
  return { band: "expedition", transport: "expedition", travelMinutes: driveMin };
}

// ── Regional targets ────────────────────────────────────────────────────────

export type RegionalKind = "occurrence" | "fault";

export interface RegionalTarget {
  id: string;
  kind: RegionalKind;
  label: string;
  commodity: string | null;
  lat: number;
  lng: number;
  distanceM: number;
  bearingDeg: number;
  compass: string;
  distanceClass: DistanceClass;
  /**
   * 0..1, and it is a PRIORITY, not a probability.
   *
   * Built only from what the pack records: what kind of feature it is, whether
   * it names a commodity, and how far away it is. It is deliberately NOT run
   * through the confidence engine — that machinery weighs evidence for
   * mineralisation at a place, and a bare "there is a mapped occurrence 90 km
   * away" is not that. Presenting it on the same scale would dress a map pin up
   * as an assessment.
   */
  priority: number;
  /** Why this is on the list, in structured form so the UI can translate it. */
  reason: { kind: "known_occurrence"; commodity: string | null } | { kind: "mapped_fault"; name: string | null };
}

/**
 * How much a target's score decays with distance.
 *
 * Halves every 40 km. Distance genuinely matters — a closer occurrence is worth
 * more to someone standing here — but it must never zero a target out, or this
 * becomes the same distance filter in a different coat.
 */
const HALF_LIFE_M = 40_000;

function decay(distanceM: number): number {
  return Math.pow(0.5, distanceM / HALF_LIFE_M);
}

/**
 * Everything the pack knows about, ranked, at ANY distance.
 *
 * `limit` caps the LIST, not the range. Nothing is dropped for being far.
 */
export function regionalTargets(
  data: PackData,
  from: { lat: number; lng: number },
  opts: { limit?: number; minDistanceM?: number } = {},
): RegionalTarget[] {
  const limit = opts.limit ?? 12;
  // Skips whatever the local engine is already handling, so the two lists do
  // not show the same feature twice.
  const minDistanceM = opts.minDistanceM ?? 0;

  const out: RegionalTarget[] = [];

  for (const o of data.occurrences) {
    const distanceM = haversineM(from, { lat: o.lat, lng: o.lng });
    if (distanceM < minDistanceM) continue;
    const b = bearingDeg(from, { lat: o.lat, lng: o.lng });
    out.push({
      id: `occ:${o.id}`,
      kind: "occurrence",
      label: o.name ?? o.commodity_key ?? "occurrence",
      commodity: o.commodity_key,
      lat: o.lat, lng: o.lng,
      distanceM, bearingDeg: b, compass: compassPoint(b),
      distanceClass: classifyDistance(distanceM),
      // A named commodity is a stronger lead than an unattributed pin.
      priority: (o.commodity_key ? 0.9 : 0.6) * decay(distanceM),
      reason: { kind: "known_occurrence", commodity: o.commodity_key },
    });
  }

  for (const f of data.mapFeatures) {
    if (f.kind !== "fault") continue;
    let best = Infinity;
    let bestPoint: { lat: number; lng: number } | null = null;
    for (const line of f.lines) {
      const d = pointToPolylineM(from, line);
      if (d >= best) continue;
      best = d;
      // Nearest vertex stands in for the nearest point when naming a direction;
      // it lies on the same stretch of the line.
      let vd = Infinity;
      for (const [lng, lat] of line) {
        const dv = haversineM(from, { lat, lng });
        if (dv < vd) { vd = dv; bestPoint = { lat, lng }; }
      }
    }
    if (!bestPoint || !Number.isFinite(best) || best < minDistanceM) continue;
    const b = bearingDeg(from, bestPoint);
    out.push({
      id: `fault:${f.id}`,
      kind: "fault",
      label: f.name ?? "fault",
      commodity: null,
      lat: bestPoint.lat, lng: bestPoint.lng,
      distanceM: best, bearingDeg: b, compass: compassPoint(b),
      distanceClass: classifyDistance(best),
      // Structure is a setting, not an occurrence: worth walking to, worth less
      // than a recorded find.
      priority: 0.45 * decay(best),
      reason: { kind: "mapped_fault", name: f.name ?? null },
    });
  }

  out.sort((a, b) => b.priority - a.priority || a.distanceM - b.distanceM);
  return out.slice(0, limit);
}
