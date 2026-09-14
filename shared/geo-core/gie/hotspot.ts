// Where inside the target area is actually worth standing?
//
// MOVED from mobile/lib/geo/hotspot.ts (Solo→Team shared-targeting Phase 1).
// The scoring is UNCHANGED: the SAME `prospectivityEvidence` -> `collapseGroups`
// -> `computeConfidence` path the ranking uses, asked about smaller pieces of
// ground. Only the h3 cell math (`cellCentre`/`childrenOf`) is injected, since
// h3-js needs a different binding per runtime (Metro vs Deno) — see
// shared/geo-core/geo/h3.ts's own header note; this file follows the same
// "shared contract, per-runtime transport" pattern already established there.
//
// A target is an H3 resolution-7 cell: about 5 km2, up to 2.4 km across. Telling
// a geologist "you have arrived" at the edge of that and stopping is not much of
// a recommendation — they still have a morning's walking to decide where to put
// the hammer.
//
// WHEN THERE IS NO HOTSPOT
//
// Usually. Five square kilometres of one lithology with no structure in it scores
// identically everywhere, and the honest output is "no part of this area stands
// out — work it as an area". `MIN_LIFT` is what separates the two, and it is
// deliberately not small.
import { computeConfidence } from "../confidence.ts";
import type { PackData } from "../pack/types.ts";
import {
  collapseGroups, prospectivityEvidence,
  type PackPriorOps, type ProspectivityOptions,
} from "./prospectivityEvidence.ts";

/**
 * How much better than the cell centre a point must score to be called a hotspot.
 *
 * The smallest single piece of evidence in the model contributes about 0.15, so
 * a lift below this is inside the noise of which sample point happened to fall
 * nearer a mapped line — not a statement about the rock.
 */
export const MIN_LIFT = 0.08;

/** Two resolutions down: 49 children of a res-7 cell, ~0.1 km2 each. */
export const HOTSPOT_FINER_BY = 2;

export interface MissionHotspot {
  lat: number;
  lng: number;
  /** The finer H3 cell it sits in — the evidence is per-cell, so this is its id. */
  cell: string;
  score: number;
  /** How much better than the target cell's own centre. */
  liftOverCentre: number;
}

/** The minimal geo-context read surface this file needs. */
export interface HotspotGeoContextSource {
  contextAt(lat: number, lng: number, opts?: { radiusM?: number }): Promise<{ context: import("../types.ts").GeoContext }>;
}

/** The h3 cell math this file needs — injected, see header note. */
export interface HotspotH3Ops {
  cellCentre(cell: string): { lat: number; lng: number };
  childrenOf(cell: string, finerBy?: number): string[];
}

const DEFAULT_RADIUS_M = 10_000;

/**
 * The best place to start inside `cell`, or null when nothing stands out.
 *
 * Runs once, on arrival — not per fix. Scoring 49 points costs about what one
 * ranking costs.
 */
export async function hotspotIn(
  geo: HotspotGeoContextSource,
  h3: HotspotH3Ops,
  pack: PackData | null,
  cell: string,
  opts: { commodity?: string | null; radiusM?: number } = {},
  packOps?: PackPriorOps,
): Promise<MissionHotspot | null> {
  const children = h3.childrenOf(cell, HOTSPOT_FINER_BY);
  if (children.length === 0) return null;

  const radiusM = opts.radiusM ?? DEFAULT_RADIUS_M;
  const commodity = opts.commodity ?? null;
  const scoringOpts: ProspectivityOptions = { commodity };
  const score = async (at: { lat: number; lng: number }): Promise<number> => {
    const { context } = await geo.contextAt(at.lat, at.lng, { radiusM });
    const scored = prospectivityEvidence(context, radiusM, undefined, pack ?? undefined, scoringOpts, packOps);
    return computeConfidence(collapseGroups(scored)).score;
  };

  // The baseline is the centre of the area, because that is where the app would
  // otherwise send them. A hotspot has to beat the alternative it replaces.
  const centre = h3.cellCentre(cell);
  const centreScore = await score(centre);

  let best: MissionHotspot | null = null;
  for (const child of children) {
    const at = h3.cellCentre(child);
    const s = await score(at);
    if (best == null || s > best.score) {
      best = { lat: at.lat, lng: at.lng, cell: child, score: s, liftOverCentre: s - centreScore };
    }
  }

  if (!best || best.liftOverCentre < MIN_LIFT) return null;
  return best;
}
