// Enrichment, shrunk toward honesty — the maths behind every measured prior.
//
// Two layers now earn their weight the same way: a rock class, and a landform
// class. Both ask one question — do the mapped occurrences concentrate in this
// class beyond what its share of the ground would give it? — and both must
// answer it with the same restraint, or the app ends up with two subtly
// different notions of "enriched" and no way to compare them.
//
// So the arithmetic lives here once. It is deliberately small:
//
//   expected    = totalOccurrences x (class area / total area)
//   enrichment  = (observed + K) / (expected + K)
//   weight      = cap x log2(enrichment) / log2(reference),  0 when enrichment <= 1
//
// THE SHRINKAGE IS THE POINT. Without K, a class with three occurrences in a tiny
// polygon would outrank one carrying a hundred, and a class with zero
// occurrences in 20,000 km2 would be condemned as firmly as one with zero in
// 640,000. K = 5 makes both behave: a small sample is pulled toward "no
// opinion", and only a large barren area earns a low number.
//
// AND THE CAP IS THE OTHER POINT. A prior says the ground is PERMISSIVE. It is
// the weakest true thing the app can say, and it must never approach what an
// observation of sulfides in hand is worth.

/** Occurrences' worth of pull toward "no information". */
export const SHRINKAGE = 5;

export interface ClassObservation {
  /** How many occurrences fell in this class. */
  observed: number;
  /**
   * The class's share of the opportunity — area for polygons, cell count for a
   * gridded classification. Any consistent measure of "how much ground" works,
   * because only the RATIO between classes is used.
   */
  exposure: number;
}

export interface ClassStat {
  key: string;
  observed: number;
  exposure: number;
  /** Occurrences this class would hold if they were spread evenly. */
  expected: number;
  /** Shrunken observed-over-expected. 1.0 is average ground. */
  enrichment: number;
  weight: number;
}

export interface MeasuredPrior {
  stats: ClassStat[];
  totalObserved: number;
  totalExposure: number;
  /** 0 for a class at or below average, and 0 for a class nobody measured. */
  weightFor(key: string | null | undefined, leaveOneOut?: boolean): number;
  statFor(key: string | null | undefined): ClassStat | null;
}

export function enrichmentOf(observed: number, expected: number): number {
  return (observed + SHRINKAGE) / (expected + SHRINKAGE);
}

export function weightOf(enrichment: number, cap: number, reference: number): number {
  if (!(enrichment > 1)) return 0;
  const scaled = Math.log2(enrichment) / Math.log2(reference);
  return Math.round(cap * Math.min(1, scaled) * 1000) / 1000;
}

/**
 * Fit a prior over categorical classes.
 *
 * `leaveOneOut` on the returned `weightFor` removes ONE observation from the
 * class asked about. It exists for validation: scoring a known occurrence with a
 * prior that counted that same occurrence is fitting on the test set, and the
 * harness exists to refuse that rather than argue it is negligible.
 */
export function fitPrior(
  classes: Map<string, ClassObservation>,
  opts: { cap: number; reference: number },
): MeasuredPrior {
  let totalObserved = 0, totalExposure = 0;
  for (const c of classes.values()) { totalObserved += c.observed; totalExposure += c.exposure; }

  const stats: ClassStat[] = [...classes.entries()].map(([key, c]) => {
    const expected = totalExposure > 0 ? (totalObserved * c.exposure) / totalExposure : 0;
    const enrichment = enrichmentOf(c.observed, expected);
    return {
      key,
      observed: c.observed,
      exposure: Math.round(c.exposure),
      expected: Math.round(expected * 100) / 100,
      enrichment: Math.round(enrichment * 1000) / 1000,
      weight: weightOf(enrichment, opts.cap, opts.reference),
    };
  }).sort((a, b) => b.enrichment - a.enrichment);

  const index = new Map(stats.map((s) => [s.key, s]));

  return {
    stats,
    totalObserved,
    totalExposure: Math.round(totalExposure),
    statFor: (key) => (key ? index.get(key) ?? null : null),
    weightFor: (key, leaveOneOut = false) => {
      const s = key ? index.get(key) : undefined;
      if (!s) return 0;
      if (!leaveOneOut) return s.weight;
      return weightOf(
        enrichmentOf(Math.max(0, s.observed - 1), s.expected),
        opts.cap, opts.reference,
      );
    },
  };
}
