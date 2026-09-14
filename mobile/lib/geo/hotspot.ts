// Where inside the target area is actually worth standing?
//
// MOVED to the shared geological core (shared/geo-core/gie/hotspot.ts) so Team
// Mission Mode can run the SAME hotspot search (Solo→Team shared-targeting
// Phase 1). This file is now a thin wiring shim: it pre-binds Solo's h3
// binding (cellCentre/childrenOf) and pack priors into the shared function, so
// its PUBLIC signature (`hotspotIn(geo, pack, cell, opts)`) is unchanged.
//
// A target is an H3 resolution-7 cell: about 5 km2, up to 2.4 km across.
// Telling a geologist "you have arrived" at the edge of that and stopping is
// not much of a recommendation — they still have a morning's walking to
// decide where to put the hammer. So once the area is reached, the same
// scorer is run again over the cell's 49 resolution-9 children, each about
// 0.1 km2, and the best of them is offered as a place to start.
import {
  hotspotIn as sharedHotspotIn, MIN_LIFT, HOTSPOT_FINER_BY,
  type HotspotH3Ops, type MissionHotspot,
} from "../../../shared/geo-core/gie/hotspot.ts";
import type { PackPriorOps } from "../../../shared/geo-core/gie/prospectivityEvidence.ts";
import { cellCentre, childrenOf } from "./h3.ts";
import type { OfflineGeoContextService } from "./offlineGeoContext.ts";
import type { PackData } from "../../../shared/geo-core/pack/types.ts";
import { unitAt } from "./featureInfo";
import { lithologyPriorFor } from "./lithologyPrior";
import { terrainPriorFor } from "./terrainPrior";
import { terrainIndexFor } from "./terrainIndex";
import { coverageAt } from "./evidenceCoverage";

export { MIN_LIFT, HOTSPOT_FINER_BY };
export type { MissionHotspot };

const H3_OPS: HotspotH3Ops = { cellCentre, childrenOf };

const EMPTY_PACK: PackData = {
  geology: [], occurrences: [], knowledge: [], structures: [], community: [],
  mapFeatures: [], terrain: [], associations: [], rules: [], commodities: [],
  assemblages: [], land: [],
};

/** Same pack-priors binding targeting.ts uses — see its own comment for why. */
const SOLO_PACK_OPS: PackPriorOps = {
  unitAt,
  lithologyPriorFor,
  terrainPriorFor,
  terrainIndexFor,
  coverageAt: (pack, produced, at) => coverageAt(pack ?? EMPTY_PACK, produced, at),
};

/**
 * The best place to start inside `cell`, or null when nothing stands out.
 * Runs once, on arrival — not per fix.
 */
export async function hotspotIn(
  geo: OfflineGeoContextService,
  pack: PackData | null,
  cell: string,
  opts: { commodity?: string | null; radiusM?: number } = {},
): Promise<MissionHotspot | null> {
  return sharedHotspotIn(geo, H3_OPS, pack, cell, opts, SOLO_PACK_OPS);
}
