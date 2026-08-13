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
import { DEFAULT_ROAD_FACTOR, MAX_ROAD_FACTOR } from "./roadFactor";

export type TargetBand = "immediate" | "local" | "regional" | "expedition";
export type Transport = "walk" | "walk_or_drive" | "vehicle" | "expedition";

export interface DistanceClass {
  band: TargetBand;
  transport: Transport;
  /** Minutes, for the recommended transport. Null when it cannot be honestly estimated. */
  travelMinutes: number | null;
  /**
   * Metres the journey is likely to cost, as opposed to the straight line.
   *
   * Equal to the straight line on foot — you walk over ground, and across a few
   * hundred metres a road is irrelevant. Multiplied by the road factor once the
   * recommendation is to drive, because from there on the road is the journey.
   */
  travelDistanceM: number;
  /** The multiplier applied, so the screen can say so. 1 means none. */
  roadFactorApplied: number;
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

/**
 * MEASURED, on the ground this app is for.
 *
 * This was 35, chosen because "vehicle in this country means unsealed track far
 * more often than tarmac" — a reasonable guess, and a guess. The Karkaar
 * expedition of 07–08/08/2026 replaced it with an odometer and a clock:
 *
 *     straight line   64.49 km   (PostGIS, from the recorded fixes)
 *     road, one way  130.00 km   (odometer)          -> factor 2.02
 *     average speed   40 km/h    (the geologist's own figure)
 *     elapsed          3 h 15
 *
 * With those two numbers the model reproduces that journey exactly, which is
 * the only test of a travel estimate that means anything. Both halves matter
 * and they answer different questions: DISTANCE plans fuel, TIME plans
 * daylight. Getting the total right by inflating distance and slowing speed in
 * compensation would give a usable clock and a useless fuel figure.
 */
export const VEHICLE_KMH = 40;

export const BAND_LIMITS_M = {
  immediate: 500,
  local: 5_000,
  regional: 50_000,
} as const;

/**
 * Band, transport and an HONEST travel estimate.
 *
 * The defect this closes: every estimate was computed from `haversineM`, a
 * straight line, and then presented beside the words "Travel time". A geologist
 * planned a night drive on "2 h 42 min" for a target 94.4 km away. The road to
 * it is about 190 km — nearly five hours. The maths was right and the question
 * was wrong.
 *
 * ON FOOT the straight line stands: you walk over the ground. ONCE DRIVING the
 * road factor applies, because from there on the road is the journey.
 *
 * `factor` is injected so this stays pure and testable; callers pass the
 * device's measured value (see geo/roadFactor).
 */
export function classifyDistance(
  distanceM: number,
  factor: number = DEFAULT_ROAD_FACTOR,
): DistanceClass {
  if (!Number.isFinite(distanceM) || distanceM < 0) {
    return {
      band: "immediate", transport: "walk", travelMinutes: null,
      travelDistanceM: 0, roadFactorApplied: 1,
    };
  }

  // A road is never shorter than the straight line; a nonsense factor must not
  // become a nonsense plan.
  const f = Number.isFinite(factor) ? Math.min(MAX_ROAD_FACTOR, Math.max(1, factor)) : 1;

  const straightKm = distanceM / 1000;
  const walkMin = Math.round((straightKm / WALK_KMH) * 60);
  const driveKm = straightKm * f;
  const driveMin = Math.round((driveKm / VEHICLE_KMH) * 60);

  if (distanceM <= BAND_LIMITS_M.immediate) {
    return {
      band: "immediate", transport: "walk", travelMinutes: walkMin,
      travelDistanceM: distanceM, roadFactorApplied: 1,
    };
  }
  if (distanceM <= BAND_LIMITS_M.local) {
    return {
      band: "local", transport: "walk_or_drive", travelMinutes: walkMin,
      travelDistanceM: distanceM, roadFactorApplied: 1,
    };
  }
  if (distanceM <= BAND_LIMITS_M.regional) {
    return {
      band: "regional", transport: "vehicle", travelMinutes: driveMin,
      travelDistanceM: driveKm * 1000, roadFactorApplied: f,
    };
  }
  return {
    band: "expedition", transport: "expedition", travelMinutes: driveMin,
    travelDistanceM: driveKm * 1000, roadFactorApplied: f,
  };
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
  opts: { limit?: number; minDistanceM?: number; roadFactor?: number } = {},
): RegionalTarget[] {
  const limit = opts.limit ?? 12;
  // Injected rather than read here: this module stays pure, and the caller
  // supplies whatever this device has measured (see geo/roadFactor).
  const factor = opts.roadFactor ?? DEFAULT_ROAD_FACTOR;
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
      distanceClass: classifyDistance(distanceM, factor),
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
      distanceClass: classifyDistance(best, factor),
      // Structure is a setting, not an occurrence: worth walking to, worth less
      // than a recorded find.
      priority: 0.45 * decay(best),
      reason: { kind: "mapped_fault", name: f.name ?? null },
    });
  }

  out.sort((a, b) => b.priority - a.priority || a.distanceM - b.distanceM);
  return out.slice(0, limit);
}
