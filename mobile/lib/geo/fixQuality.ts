// How good is this fix, really?
//
// Never claim precision the receiver did not report. A phone under an open sky
// in the Horn commonly settles around 5–10 m; under cliff or canopy it drifts to
// 50 m and keeps drawing the same confident blue dot. A geologist deciding
// whether they have reached a target 400 m away needs to know which of those
// they are looking at, because at 50 m accuracy "you have arrived" is a guess.
//
// Everything here is derived from what the platform reported. Nothing is
// smoothed, assumed, or improved.

/** Above this, the fix is too loose to navigate a small target with. */
export const POOR_ACCURACY_M = 30;
/** Below this the fix is as good as a phone gets, and worth saying so. */
export const GOOD_ACCURACY_M = 10;
/** A fix older than this has stopped describing where you are. */
export const STALE_FIX_MS = 30_000;

export type FixGrade = "good" | "usable" | "poor" | "stale" | "none";

export interface FixQuality {
  grade: FixGrade;
  accuracyM: number | null;
  /** Milliseconds since the fix, or null when there is no fix. */
  ageMs: number | null;
  /** True when the geologist should be told before acting on a distance. */
  warn: boolean;
}

export function gradeFix(
  fix: { accuracyM: number | null; timestamp?: number | null } | null,
  now: number = Date.now(),
): FixQuality {
  if (!fix) return { grade: "none", accuracyM: null, ageMs: null, warn: true };

  const ageMs = fix.timestamp == null ? null : Math.max(0, now - fix.timestamp);
  // A stale fix is worse than a loose one: it is precise about somewhere you
  // have already left. Age is judged before accuracy for that reason.
  if (ageMs != null && ageMs > STALE_FIX_MS) {
    return { grade: "stale", accuracyM: fix.accuracyM, ageMs, warn: true };
  }

  const a = fix.accuracyM;
  // The platform declining to report accuracy is not the same as good accuracy.
  // It is graded "usable" and left unwarned, because refusing to navigate on
  // every device that omits the field would be its own failure.
  if (a == null || !Number.isFinite(a)) {
    return { grade: "usable", accuracyM: null, ageMs, warn: false };
  }
  if (a <= GOOD_ACCURACY_M) return { grade: "good", accuracyM: a, ageMs, warn: false };
  if (a <= POOR_ACCURACY_M) return { grade: "usable", accuracyM: a, ageMs, warn: false };
  return { grade: "poor", accuracyM: a, ageMs, warn: true };
}

/**
 * Arrival radius for a fix of this quality.
 *
 * A tighter fix earns a tighter arrival. Declaring arrival inside 25 m on a
 * 60 m fix means announcing it while still a football pitch away, and a
 * geologist who is told they have arrived stops walking.
 */
export function arrivalRadiusFor(accuracyM: number | null): number {
  const a = accuracyM == null || !Number.isFinite(accuracyM) ? 20 : accuracyM;
  return Math.max(25, Math.min(150, a * 2.5));
}
