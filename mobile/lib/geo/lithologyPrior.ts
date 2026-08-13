// Which rock classes actually host mineralisation here — measured, not asserted.
//
// WHY THIS EXISTS. Mapped geology contributed nothing to prospectivity, and the
// reason was sound: scoring a cell for being well mapped would send a geologist
// to wherever the survey happened to be good. But the correction went too far.
// Measured against the pack on 10 August 2026:
//
//   sedimentary and volcaniclastic    9 occ    15,207 km2    8.3x enriched
//   metamorphic                     109 occ   220,836 km2    6.9x
//   sedimentary                      40 occ 1,193,698 km2    0.5x
//   volcanic                          0 occ   640,116 km2    0.0x
//
// 118 of 158 mapped occurrences — 75% — sit inside 11% of the mapped area. That
// is not a mapping artefact; it is the Somali basement. The Neoproterozoic
// metamorphic terrain of the Arabian-Nubian Shield hosts the mineralisation, and
// the Mesozoic-Cenozoic cover does not.
//
// AND IT IS THE CLEANEST LAYER AVAILABLE. The leakage detector puts geology at a
// coverage ratio of 0.99 — present at 99% of occurrences and 100% of background.
// Unlike terrain (ratio 150), knowing geology exists here tells you nothing about
// whether anyone has already found something.
//
// WHY LITHOLOGY AND NOT AGE. Age carries almost the same signal — Neoproterozoic
// is 4.68x enriched — because Neoproterozoic and metamorphic are largely the same
// rocks. Scoring both would count one observation twice, which is precisely the
// correlated-evidence error this project has already been criticised for. One
// term. Lithology is the stronger of the two, so lithology is the one used.
//
// WHAT THIS IS NOT. It is a PRIOR: permissive ground, not a find. It is capped
// well below what an occurrence or a field observation of sulfides can contribute,
// because "you are standing on the right kind of rock" is the weakest true thing
// the app can say.
import { pointInRings } from "./featureInfo";
import { fitPrior, type ClassObservation, type MeasuredPrior } from "./measuredPrior";
import type { PackData } from "../../../shared/geo-core/pack/types";

/**
 * The most a rock class may contribute.
 *
 * Comparable to the commodity-association cap (0.35) and far below an occurrence
 * (up to 0.9) or observed sulfides (0.85). Being on prospective lithology is a
 * reason to look, never a reason to believe.
 */
export const MAX_LITHOLOGY_WEIGHT = 0.3;

/** The enrichment at which a class earns the full weight. */
const REFERENCE_ENRICHMENT = 8;

/**
 * A rock class and what the pack says about it.
 *
 * Field names come from the shared prior: `key` is the lithology, `observed` the
 * occurrences inside it, `exposure` its area in km2.
 */
export type LithologyStat = import("./measuredPrior").ClassStat;
export type LithologyPrior = MeasuredPrior;

/** Planar area with a cos(lat) correction — comparing classes, not surveying. */
function ringAreaKm2(ring: ReadonlyArray<readonly [number, number]>): number {
  if (ring.length < 3) return 0;
  let sum = 0;
  let latSum = 0;
  for (const p of ring) latSum += p[1];
  const k = Math.cos((latSum / ring.length) * Math.PI / 180);
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    sum += ring[j][0] * k * ring[i][1] - ring[i][0] * k * ring[j][1];
  }
  return Math.abs(sum / 2) * 111.32 * 111.32;
}

/**
 * Fit the prior from the pack itself.
 *
 * Deterministic, and derived entirely from data already on the device: no table
 * to ship, no constants to drift out of step with the pack they describe. A pack
 * with new geology or new occurrences produces a new prior automatically.
 */
export function buildLithologyPrior(pack: PackData): LithologyPrior {
  const classes = new Map<string, ClassObservation>();

  const polygons = (pack.geology ?? []).filter((g) => g.isPolygon && g.rings.length > 0);
  for (const g of polygons) {
    const kind = g.kind || "unknown";
    const c = classes.get(kind) ?? { observed: 0, exposure: 0 };
    // Outer ring only. Subtracting holes would be more exact and the pack's units
    // have none; using every ring would double-count any that appeared later.
    c.exposure += ringAreaKm2(g.rings[0] as ReadonlyArray<readonly [number, number]>);
    classes.set(kind, c);
  }

  for (const o of pack.occurrences ?? []) {
    const unit = polygons.find(
      (g) =>
        o.lng >= g.bbox[0] && o.lng <= g.bbox[2] && o.lat >= g.bbox[1] && o.lat <= g.bbox[3] &&
        pointInRings(g.rings, { lat: o.lat, lng: o.lng }),
    );
    if (!unit) continue;   // outside every mapped unit: it informs no class
    const c = classes.get(unit.kind || "unknown");
    if (c) c.observed++;
  }

  return fitPrior(classes, { cap: MAX_LITHOLOGY_WEIGHT, reference: REFERENCE_ENRICHMENT });
}

/**
 * One prior per pack, built on first use.
 *
 * Keyed on the pack object, so a replaced pack gets a freshly fitted prior and a
 * k-ring of 19 cells does not refit it nineteen times.
 */
const cache = new WeakMap<PackData, LithologyPrior>();

export function lithologyPriorFor(pack: PackData): LithologyPrior {
  let p = cache.get(pack);
  if (!p) { p = buildLithologyPrior(pack); cache.set(pack, p); }
  return p;
}
