// Turning engine numbers into words, in the reader's language.
//
// Every one of these takes `t` and returns a translated string. None of them
// decides anything: the bands, transports and travel minutes are computed in
// geo/expedition from measured distances, and the recorder accumulates the
// traverse stats. This file only chooses how to SAY them, which is the one part
// that must differ between English and Somali.
//
// It exists so the exploration screen does not accumulate a second, slightly
// different copy of "how do we write a distance" every time a new panel needs
// one. There is exactly one rule per unit, and it lives here.
import type { DistanceClass, TargetBand, Transport } from "../geo/expedition";

export type TFunc = (k: string, o?: Record<string, unknown>) => string;

/**
 * Distances go through i18n so the UNIT WORD is translatable: "m" is not
 * "mitir", and a Somali reader should never meet an English abbreviation.
 */
export function formatDistance(t: TFunc, m: number): string {
  if (!Number.isFinite(m)) return "—";
  return m >= 1000
    ? t("field.distance.km", { value: (m / 1000).toFixed(m >= 100_000 ? 0 : 1) })
    : t("field.distance.m", { value: Math.round(m) });
}

/**
 * Travel time, at the granularity the estimate deserves.
 *
 * Minutes below an hour, hours and minutes below a day, whole days beyond that.
 * Nothing is rounded up into a more confident-sounding number: a two-day drive
 * is reported as two days, not as "48 h", which reads like a schedule.
 */
export function formatTravel(t: TFunc, minutes: number | null): string {
  if (minutes == null || !Number.isFinite(minutes) || minutes < 0) {
    return t("field.travel.unknown");
  }
  if (minutes < 60) return t("field.travel.minutes", { value: Math.max(1, Math.round(minutes)) });
  if (minutes < 24 * 60) {
    const h = Math.floor(minutes / 60);
    const m = Math.round(minutes % 60);
    return m === 0
      ? t("field.travel.hours", { value: h })
      : t("field.travel.hoursMinutes", { h, m });
  }
  return t("field.travel.days", { value: Math.max(1, Math.round(minutes / (24 * 60))) });
}

export const compassKey = (c: string): string => "field.compass." + c;
export const confidenceBandKey = (b: string): string => "field.band." + b;
export const distanceBandKey = (b: TargetBand): string => "field.bandDistance." + b;
export const transportKey = (x: Transport): string => "field.transport." + x;
export const transportShortKey = (x: Transport): string => "field.transportShort." + x;

/** "Regional target · vehicle recommended · about 2 h 40 min" — one line. */
export function describeClass(t: TFunc, c: DistanceClass): string {
  return t("field.sheet.travelLine", {
    band: t(distanceBandKey(c.band)),
    transport: t(transportKey(c.transport)),
    // No travel time is published without the distance it was computed from.
    road: roadClause(t, c.travelDistanceM, c.roadFactorApplied),
    travel: formatTravel(t, c.travelMinutes),
  });
}

/** Metres per second as km/h — the unit a person plans a traverse in. */
export function formatSpeed(t: TFunc, mps: number | null): string {
  if (mps == null || !Number.isFinite(mps) || mps <= 0) return t("field.track.none");
  return t("field.track.speed", { value: (mps * 3.6).toFixed(1) });
}

/** Elapsed time as h:mm, or minutes while it is still short. */
export function formatDuration(t: TFunc, ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return t("field.track.none");
  return formatTravel(t, ms / 60_000);
}

/**
 * How long ago the receiver last spoke.
 *
 * Deliberately never says "now" for something that is not now. Under a second
 * counts as just-now; past that the number is real, because the whole point of
 * showing fix age is to let someone distrust a stale position.
 */
export function formatFixAge(t: TFunc, ageMs: number | null): string {
  if (ageMs == null) return "";
  const s = Math.round(ageMs / 1000);
  if (s < 2) return t("field.gps.updatedJustNow");
  if (s < 90) return t("field.gps.updatedSeconds", { s });
  return t("field.gps.updatedMinutes", { m: Math.round(s / 60) });
}

/**
 * The accuracy the receiver actually reported.
 *
 * Kept to a tenth of a metre while it is under ten, because ±1.5 m and ±2 m are
 * different statements about whether an outcrop position is worth recording, and
 * rounding both to "±2 m" throws away the better one. Above ten metres the
 * tenths are noise and a whole number is the honest reading. Nothing here
 * improves, smooths or averages a fix.
 */
export function formatAccuracy(t: TFunc, m: number | null | undefined): string {
  if (m == null || !Number.isFinite(m)) return t("field.gps.accuracyUnknown");
  const value = m < 10 ? (Math.round(m * 10) / 10).toFixed(1) : String(Math.round(m));
  return t("field.gps.accuracyValue", { value });
}

/** Elevation of a target relative to the viewer, or an honest "unknown". */
export function formatElevationDelta(t: TFunc, deltaM: number | null): string {
  if (deltaM == null || !Number.isFinite(deltaM)) return t("field.target.elevationUnknown");
  const m = Math.round(deltaM);
  if (Math.abs(m) < 10) return t("field.target.elevationSame");
  return m > 0
    ? t("field.target.elevationUp", { m })
    : t("field.target.elevationDown", { m: Math.abs(m) });
}

/**
 * A distance that says what it measures.
 *
 * Contract clause 4: every figure states its own basis. The failure this closes
 * was not an arithmetic error — 94.4 km was correct — it was a geodesic distance
 * printed beside the words "Travel time", which implies a road. On foot there is
 * nothing to add: you walk over the ground. Once driving, BOTH numbers are shown
 * and the multiplier is named, so a geologist can judge it instead of trusting it.
 */
export function formatTravelDistance(
  t: TFunc,
  straightM: number,
  travelM: number,
  factorApplied: number,
): string {
  const straight = Math.round(straightM / 1000);
  if (factorApplied <= 1.001) return t("field.distance.straightOnly", { km: straight });
  return t("field.distance.withRoad", {
    straight,
    road: Math.round(travelM / 1000),
    factor: factorApplied.toFixed(1),
  });
}

/**
 * The road figure alone, for surfaces that have room for one line.
 *
 * The pill above the map is read at a glance, mid-walk, and clips to a single
 * line — so it cannot carry both numbers and the multiplier. It carries the one
 * a geologist plans fuel and daylight around, marked `~` as an estimate.
 *
 * Returns null when no multiplier was applied, because there is then no second
 * number to report and repeating the straight line would imply there was.
 */
export function formatRoadDistance(
  t: TFunc,
  travelM: number,
  factorApplied: number,
): string | null {
  if (!(factorApplied > 1.001) || !Number.isFinite(travelM)) return null;
  return t("field.distance.roadShort", { road: Math.round(travelM / 1000) });
}

/**
 * Just the kilometres, for a column eight characters wide.
 *
 * The four-up stat row is read at a glance and each cell is a quarter of the
 * screen. Putting the full labelled figure there rendered "94 km t…", which is
 * worse than either number alone — so the cell carries the road distance and its
 * LABEL says which distance it is.
 */
export function formatRoadKm(t: TFunc, travelM: number, factorApplied: number): string | null {
  if (!(factorApplied > 1.001) || !Number.isFinite(travelM)) return null;
  return t("field.distance.roadKm", { road: Math.round(travelM / 1000) });
}

/**
 * The road figure WITH its basis, as a clause a sentence can absorb.
 *
 * Prose has room for the multiplier, and prose is where the reader is deciding
 * whether to set out — so the sentence that says "about four hours" must also
 * say which distance those hours were computed from and on what authority.
 * Empty when no multiplier applied, so the sentence closes normally.
 */
export function roadClause(t: TFunc, travelM: number, factorApplied: number): string {
  if (!(factorApplied > 1.001) || !Number.isFinite(travelM)) return "";
  return ` · ${t("field.distance.roadEstimate", {
    road: Math.round(travelM / 1000),
    factor: factorApplied.toFixed(1),
  })}`;
}

/**
 * A timestamp on the geologist's own clock.
 *
 * FIELD-REPORTED, and it was mine. The field report printed `2026-08-12 11:29`
 * for a section finished at 14:29 East Africa Time: `toISOString()` renders UTC,
 * and the screen presented it under the label "Date" as though it were the time
 * on the phone. Three hours out, on the one record whose whole job is to say when
 * somebody stood somewhere.
 *
 * Built from the local getters rather than `toLocaleString`, because those need
 * no Intl data and cannot vary with what a given Hermes build shipped with.
 * `getMonth` is zero-based; `getHours` and friends are already local.
 */
export function localStamp(ms: number, withTime = true): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  const day = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return withTime ? `${day} ${p(d.getHours())}:${p(d.getMinutes())}` : day;
}
