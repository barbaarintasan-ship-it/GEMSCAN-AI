// Landform as evidence — measured on an independent DEM, and honest about what
// it is measuring.
//
// WHY IT COULD NOT BE DONE BEFORE. The pack shipped 2,191 terrain cells sampled
// in a k-ring around each known occurrence: 100% of them lay within 6.1 km of
// one, a coverage ratio of 150 against background. "This ground has terrain data"
// was a near-perfect proxy for "somebody already found something here", and
// scoring it would have lifted every validation number while teaching the model
// nothing. Terrain was withheld for exactly that reason.
//
// Copernicus GLO-30 replaced it with country-wide coverage. The leakage detector
// now puts terrain at ratio 1.37 — under the 2.0 limit — so it is admissible on
// the same terms geology was, and the admission gate then measured whether it
// actually helps:
//
//     BLIND  with terrain  AUC 0.843  lift 2.486
//            without       AUC 0.810  lift 2.301
//
// IT SHIPS AT H3 RESOLUTION 6, not the engine's 7. At 7 the country needs 254,623
// rows, and Metro materialises pack JSON as live objects at startup: the app went
// from 297 MB at rest to 588 MB — worse than the memory pressure that was
// freezing it. Resolution 6 is 36,505 cells of 36 km2, costs 0.010 of AUC, and
// saves 67 MB. Morphology is a neighbourhood property and survives the coarser
// grid; elevation and slope carry a `fromM` saying how far the reading travelled.
//
// WHAT THE DATA SAID at resolution 7 (159 occurrences, 254,623 cells) — the same
// ordering holds at 6:
//
//   valley   61 occ   30,745 cells   3.18x
//   ridge    27 occ   34,880 cells   1.24x
//   slope    16 occ   31,801 cells   0.81x
//   flat     55 occ  157,197 cells   0.56x
//
// THE CAVEAT, AND IT IS A REAL ONE. This may be partly DISCOVERY bias rather than
// mineralisation. Valleys and steep ground expose bedrock; flat plains bury it
// under cover. MRDS records where geologists went and could see rock — so some of
// the valley signal is "you can find things here", not "there are more things
// here". That is still useful to an explorer, and it is not the same claim, so the
// evidence statement says landform and exposure rather than promising ore.
//
// ONE TERM, NOT THREE. Slope (12 deg+ at 3.54x) and relief (150 m+ at 2.56x) both
// carry signal and both are largely the SAME signal — morphology is derived from
// slope and topographic position, so the three are collinear. Scoring them
// separately would count one observation three times, which is the
// correlated-evidence error this project has already been criticised for.
//
// COMMODITY CONDITIONING. The weight here is a base rate over all commodities. A
// commodity profile multiplies it per deposit style — drainage and valley
// position matter enormously for placer and barely for an orogenic lode — and
// that multiplier arrives with the profiles. Until then it is 1.0 for everything,
// which is the honest default rather than a guess dressed as a model.
import { fitPrior, type ClassObservation, type MeasuredPrior } from "./measuredPrior";
import { terrainIndexFor } from "./terrainIndex";
import type { PackData } from "../../../shared/geo-core/pack/types";

/**
 * The most a landform class may contribute.
 *
 * Below lithology's 0.3, deliberately. Rock class is a statement about what the
 * ground IS; landform is partly a statement about whether you can see it.
 */
export const MAX_TERRAIN_WEIGHT = 0.22;

/** The enrichment at which a class earns the full weight. */
const REFERENCE_ENRICHMENT = 4;

/** How far a DEM cell may be from a point and still describe it. */
export const TERRAIN_MATCH_M = 5_000;

export type TerrainPrior = MeasuredPrior;

/**
 * Fit from the pack: occurrences per landform class, against cells per class.
 *
 * `exposure` is a CELL COUNT rather than an area, because the DEM grid is uniform
 * — every H3 cell is the same size, so counting them is exactly proportional to
 * area and avoids a second area computation that could disagree with the first.
 */
export function buildTerrainPrior(pack: PackData): TerrainPrior {
  const classes = new Map<string, ClassObservation>();
  const cells = pack.terrain ?? [];

  for (const t of cells) {
    const c = classes.get(t.morphology) ?? { observed: 0, exposure: 0 };
    c.exposure += 1;
    classes.set(t.morphology, c);
  }

  const index = terrainIndexFor(cells);
  for (const o of pack.occurrences ?? []) {
    const t = index.nearest(o.lat, o.lng, TERRAIN_MATCH_M);
    if (!t) continue;   // no DEM here: it informs no class
    const c = classes.get(t.morphology);
    if (c) c.observed++;
  }

  return fitPrior(classes, { cap: MAX_TERRAIN_WEIGHT, reference: REFERENCE_ENRICHMENT });
}

const cache = new WeakMap<PackData, TerrainPrior>();

export function terrainPriorFor(pack: PackData): TerrainPrior {
  let p = cache.get(pack);
  if (!p) { p = buildTerrainPrior(pack); cache.set(pack, p); }
  return p;
}
