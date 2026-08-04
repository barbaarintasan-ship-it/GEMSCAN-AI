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

/** Elevation of a target relative to the viewer, or an honest "unknown". */
export function formatElevationDelta(t: TFunc, deltaM: number | null): string {
  if (deltaM == null || !Number.isFinite(deltaM)) return t("field.target.elevationUnknown");
  const m = Math.round(deltaM);
  if (Math.abs(m) < 10) return t("field.target.elevationSame");
  return m > 0
    ? t("field.target.elevationUp", { m })
    : t("field.target.elevationDown", { m: Math.abs(m) });
}
