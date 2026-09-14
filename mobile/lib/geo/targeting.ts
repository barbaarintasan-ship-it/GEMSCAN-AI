// TargetingEngine — workflow step 3, "where should I go, and why?" (Stage E4).
//
// MOVED to the shared geological core (shared/geo-core/gie/targetingEngine.ts
// + prospectivityEvidence.ts) so Team Mission Mode can call the SAME
// deterministic targeting/scoring logic (Solo→Team shared-targeting Phase 1).
//
// This file is now a THIN WIRING SHIM, not a second implementation:
//   - every scoring function is re-exported, unchanged, from shared/geo-core
//   - `TargetingEngine` here is a subclass that pre-binds Solo's own h3
//     binding, perf-pacing hooks (markPhase/yieldToFrame) and pack-derived
//     structural/lithology/terrain priors into the shared engine, so its
//     PUBLIC constructor (`new TargetingEngine(geo, local, pack)`) and every
//     method are BYTE-IDENTICAL to before this move — no caller anywhere in
//     Solo needed to change.
//
// GeoContext answers what is HERE. Targeting answers where to go NEXT: it
// scores the neighbouring H3 cells and ranks them, deterministically and
// offline, using the same evidence and the same confidence model as
// everything else.
//
// Two rules constrain the whole design:
//   Invariant 2 — no unexplained recommendation. Every target carries the
//     evidence statements that produced it, because a user with no geological
//     training is being asked to walk somewhere.
//   Invariant 4 — no fabricated geology. A cell with no evidence scores zero
//     and is not recommended. "I don't know here" is a valid output.
import {
  TargetingEngine as SharedTargetingEngine,
  type GeoContextBatchSource, type H3Ops, type EnginePerfHooks,
} from "../../../shared/geo-core/gie/targetingEngine.ts";
import type { PackPriorOps } from "../../../shared/geo-core/gie/prospectivityEvidence.ts";
import { cellFor, cellCentre, kRing } from "./h3.ts";
import { markPhase } from "../diagnostics/jsStall";
import { yieldToFrame } from "../perf/frameYield.ts";
import type { OfflineGeoContextService } from "./offlineGeoContext.ts";
import type { LocalEvidenceSource } from "../exploration/localEvidence.ts";
import type { PackData } from "../../../shared/geo-core/pack/types.ts";
import { unitAt } from "./featureInfo";
import { lithologyPriorFor } from "./lithologyPrior";
import { terrainPriorFor } from "./terrainPrior";
import { terrainIndexFor } from "./terrainIndex";
import { coverageAt } from "./evidenceCoverage";
import {
  prospectivityEvidence as sharedProspectivityEvidence,
  type Scored, type ProspectivityOptions,
} from "../../../shared/geo-core/gie/prospectivityEvidence.ts";
import type { GeoContext } from "../../../shared/geo-core/types.ts";

// Re-exported explicitly (not `export *`) because this file declares its own
// `TargetingEngine` AND `prospectivityEvidence` below — the mobile bindings,
// not the shared base implementations.
export {
  DEFAULT_TARGETING, DEFAULT_CONTEXT_RADIUS_M,
  collapseGroups,
  type ExplorationTarget, type TargetingResult, type TargetingOptions,
  type GeoContextQueryFn, type GeoContextBatchSource, type H3Ops, type EnginePerfHooks,
  type Scored, type TargetReason, type ProspectivityOptions,
  type PackPriorOps, type LocalEvidenceSource, type EvidenceCoverage,
} from "../../../shared/geo-core/gie/targetingEngine.ts";

const EMPTY_PACK: PackData = {
  geology: [], occurrences: [], knowledge: [], structures: [], community: [],
  mapFeatures: [], terrain: [], associations: [], rules: [], commodities: [],
  assemblages: [], land: [],
};

const H3_OPS: H3Ops = { cellFor, cellCentre, kRing };
const PERF_HOOKS: EnginePerfHooks = { markPhase, yieldToFrame };

/**
 * Solo's pack-derived priors (lithology/terrain/mapped-unit + coverage), bound
 * into the shared engine. This is the ONLY reason `mobile/lib/geo/targeting.ts`
 * still exists as more than a bare re-export: these four functions need
 * mobile's h3-backed spatial index (terrainIndex.ts) to build, which is why
 * they are injected rather than moved — see prospectivityEvidence.ts's own
 * header note.
 */
const SOLO_PACK_OPS: PackPriorOps = {
  unitAt,
  lithologyPriorFor,
  terrainPriorFor,
  terrainIndexFor,
  coverageAt: (pack, produced, at) => coverageAt(pack ?? EMPTY_PACK, produced, at),
};

/**
 * Mobile binding of the shared evidence function — SAME algorithm, pre-wired
 * with Solo's pack priors so every EXISTING direct caller (validation tests,
 * structuredEvidenceSource.ts) keeps getting structural/lithology/terrain
 * evidence exactly as before, without needing to know `packOps` now exists.
 * Solo's public signature (5 args, no `packOps`) is unchanged.
 */
export function prospectivityEvidence(
  ctx: GeoContext,
  radiusM: number,
  local?: LocalEvidenceSource,
  pack?: PackData,
  opts: ProspectivityOptions = {},
): Scored[] {
  return sharedProspectivityEvidence(ctx, radiusM, local, pack, opts, SOLO_PACK_OPS);
}

/**
 * Mobile binding of the shared engine — SAME class, pre-wired with this
 * runtime's h3 binding, perf hooks and pack priors. Solo's public API (3-arg
 * constructor) is unchanged.
 */
export class TargetingEngine extends SharedTargetingEngine {
  constructor(
    geo: OfflineGeoContextService,
    local?: LocalEvidenceSource,
    pack?: () => PackData,
  ) {
    super(
      geo as unknown as GeoContextBatchSource,
      H3_OPS,
      local,
      pack,
      SOLO_PACK_OPS,
      PERF_HOOKS,
    );
  }
}
