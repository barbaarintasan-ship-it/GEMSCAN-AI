// Where inside the target area is actually worth standing?
//
// A target is an H3 resolution-7 cell: about 5 km2, up to 2.4 km across. Telling a
// geologist "you have arrived" at the edge of that and stopping is not much of a
// recommendation — they still have a morning's walking to decide where to put the
// hammer.
//
// So once the area is reached, the same scorer is run again over the cell's 49
// resolution-9 children, each about 0.1 km2, and the best of them is offered as a
// place to start. Nothing here changes scoring: it is the SAME
// `prospectivityEvidence` -> `collapseGroups` -> `computeConfidence` path the
// ranking uses, asked about smaller pieces of ground.
//
// WHEN THERE IS NO HOTSPOT
//
// Usually. Five square kilometres of one lithology with no structure in it scores
// identically everywhere, and the honest output is "no part of this area stands
// out — work it as an area". A point returned in that case would be an invention
// dressed as a recommendation, which is the one thing this project does not do.
// `MIN_LIFT` is what separates the two, and it is deliberately not small.
import { computeConfidence } from "../../../shared/geo-core/confidence.ts";
import type { PackData } from "../../../shared/geo-core/pack/types.ts";
import { cellCentre, childrenOf } from "./h3.ts";
import { DEFAULT_CONTEXT_RADIUS_M, type OfflineGeoContextService } from "./offlineGeoContext.ts";
import { collapseGroups, prospectivityEvidence } from "./targeting.ts";
import type { MissionHotspot } from "../exploration/mission.ts";

/**
 * How much better than the cell centre a point must score to be called a hotspot.
 *
 * Set against what the engine's weights can actually resolve. The smallest single
 * piece of evidence in the model contributes about 0.15, so a lift below this is
 * inside the noise of which sample point happened to fall nearer a mapped line —
 * not a statement about the rock.
 */
export const MIN_LIFT = 0.08;

/** Two resolutions down: 49 children of a res-7 cell, ~0.1 km2 each. */
export const HOTSPOT_FINER_BY = 2;

/**
 * The best place to start inside `cell`, or null when nothing stands out.
 *
 * Runs once, on arrival — not per fix. Scoring 49 points costs about what one
 * ranking costs, and doing it on every GPS update would be the tile-decode
 * mistake all over again.
 */
export async function hotspotIn(
  geo: OfflineGeoContextService,
  pack: PackData | null,
  cell: string,
  opts: { commodity?: string | null; radiusM?: number } = {},
): Promise<MissionHotspot | null> {
  const children = childrenOf(cell, HOTSPOT_FINER_BY);
  if (children.length === 0) return null;

  const radiusM = opts.radiusM ?? DEFAULT_CONTEXT_RADIUS_M;
  const commodity = opts.commodity ?? null;
  const score = async (at: { lat: number; lng: number }): Promise<number> => {
    const { context } = await geo.contextAt(at.lat, at.lng, { radiusM });
    const scored = prospectivityEvidence(context, radiusM, undefined, pack ?? undefined, { commodity });
    return computeConfidence(collapseGroups(scored)).score;
  };

  // The baseline is the centre of the area, because that is where the app would
  // otherwise send them. A hotspot has to beat the alternative it replaces.
  const centre = cellCentre(cell);
  const centreScore = await score(centre);

  let best: MissionHotspot | null = null;
  for (const child of children) {
    const at = cellCentre(child);
    const s = await score(at);
    if (best == null || s > best.score) {
      best = { lat: at.lat, lng: at.lng, cell: child, score: s, liftOverCentre: s - centreScore };
    }
  }

  if (!best || best.liftOverCentre < MIN_LIFT) return null;
  return best;
}
