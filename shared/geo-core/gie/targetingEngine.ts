// TargetingEngine — "where should I go, and why?"
//
// MOVED from mobile/lib/geo/targeting.ts (Solo→Team shared-targeting Phase 1) so
// Team Mission Mode can call the SAME deterministic ranking logic Solo
// Exploration uses. The class and its scoring are UNCHANGED from the version
// that shipped in mobile/lib/geo/targeting.ts — see that file (now a re-export
// shim) for Solo's wiring.
//
// GeoContext answers what is HERE. This answers where to go NEXT: it scores the
// neighbouring H3 cells and ranks them, deterministically, using the same
// evidence and the same confidence model as everything else.
//
// Two rules constrain the whole design:
//   Invariant 2 — no unexplained recommendation. Every target carries the
//     evidence statements that produced it.
//   Invariant 4 — no fabricated geology. A cell with no evidence scores zero
//     and is not recommended. "I don't know here" is a valid output.
//
// WHY h3 AND PERF PACING ARE INJECTED, NOT IMPORTED
//
// h3-js needs a different binding per runtime (Metro vs Deno — see
// shared/geo-core/geo/h3.ts's own header note), and the render-frame yield
// (`yieldToFrame`)/stall diagnostics (`markPhase`) this class uses during a
// large k-ring scan are a mobile UI-thread concern with no server equivalent.
// Both are optional constructor parameters instead: Solo's shim
// (mobile/lib/geo/targeting.ts) supplies its real h3 binding and perf hooks so
// its behaviour and instrumentation are BYTE-IDENTICAL to before; a server
// caller supplies its own h3 binding and simply omits the perf hooks (there is
// no render frame to protect).
import { bearingDeg, compassPoint, haversineM } from "../geo/spatial.ts";
import { bandFor, computeConfidence } from "../confidence.ts";
import { reportProspectivity } from "./prospectivityReport.ts";
import type { ConfidenceBand, GeoContext } from "../types.ts";
import type { PackData } from "../pack/types.ts";
import {
  collapseGroups, commoditiesOf, coverageFor, prospectivityEvidence, reasonsFor,
  type EvidenceCoverage, type LocalEvidenceSource, type PackPriorOps,
  type ProspectivityOptions, type Scored, type TargetReason,
} from "./prospectivityEvidence.ts";

export type { Scored, TargetReason, ProspectivityOptions, PackPriorOps, LocalEvidenceSource, EvidenceCoverage };
export { collapseGroups, prospectivityEvidence };

export interface ExplorationTarget {
  cell: string;
  centre: { lat: number; lng: number };
  /** Degrees clockwise from true north — what the heading arrow points along. */
  bearingDeg: number;
  /** Spoken form of the bearing, e.g. "NE". */
  compass: string;
  distanceM: number;
  /** 0..1, computed from evidence — never asserted. RANKING score. */
  score: number;
  /**
   * The score to SHOW on the report — `score` moderated by evidence breadth and
   * completeness. Never used for ranking.
   */
  reportScore: number;
  band: ConfidenceBand;
  reasons: TargetReason[];
  commodities: string[];
  coverage: EvidenceCoverage;
  /** The commodity this ranking was computed under, or null for the universal engine. */
  scoredForCommodity: string | null;
  /** The raw scored evidence this target's `score`/`reportScore` were built from. */
  evidence: readonly Scored[];
}

export interface TargetingResult {
  current: { cell: string; context: GeoContext; score: number; coverage: EvidenceCoverage };
  targets: ExplorationTarget[];
  hasKnowledge: boolean;
  bestIsHere: boolean;
}

export interface TargetingOptions {
  /** How many H3 rings out to search. */
  rings?: number;
  maxDistanceM?: number;
  minScore?: number;
  limit?: number;
  radiusM?: number;
  commodity?: string | null;
}

export const DEFAULT_TARGETING: Required<Omit<TargetingOptions, "radiusM" | "commodity">> = {
  rings: 3,
  maxDistanceM: 15_000,
  minScore: 0.05,
  limit: 6,
};

export const DEFAULT_CONTEXT_RADIUS_M = 10_000;

/** One position, scored against whichever engine/gateway `openBatch()` built. */
export type GeoContextQueryFn = (
  lat: number,
  lng: number,
  opts?: { radiusM?: number },
) => Promise<{ context: GeoContext; hasKnowledge: boolean }>;

/** The minimal geo-context read surface this engine needs — Solo's
 *  OfflineGeoContextService and a server-side supabaseGateway-backed
 *  equivalent both structurally satisfy this. */
export interface GeoContextBatchSource {
  contextAt(lat: number, lng: number, opts?: { radiusM?: number }): Promise<{ context: GeoContext; hasKnowledge: boolean }>;
  openBatch(): Promise<GeoContextQueryFn>;
}

/** The h3 cell math this engine needs — injected, see header note. */
export interface H3Ops {
  cellFor(lat: number, lng: number): string;
  cellCentre(cell: string): { lat: number; lng: number };
  kRing(cell: string, rings: number): string[];
}

/** Mobile-only perf pacing — no-op by default, real hooks supplied by Solo's shim. */
export interface EnginePerfHooks {
  markPhase?: (name: string) => () => void;
  yieldToFrame?: () => Promise<void>;
}

export class TargetingEngine {
  constructor(
    private readonly geo: GeoContextBatchSource,
    private readonly h3: H3Ops,
    private readonly local?: LocalEvidenceSource,
    /** Pack access for the structural/lithology/terrain signals; omitted, targeting simply has fewer inputs. */
    private readonly pack?: () => PackData,
    private readonly packOps?: PackPriorOps,
    private readonly perf: EnginePerfHooks = {},
  ) {}

  /**
   * Score ONE cell and describe it as a target.
   *
   * Factored out of the ranking loop so `targetAt` cannot diverge from it: a cell
   * the user picks by hand must be scored by exactly the code that scores the ones
   * the engine offers.
   *
   * Returns null when the cell has nothing to say about itself — Invariant 2.
   */
  private async buildTarget(
    cell: string,
    from: { lat: number; lng: number },
    radiusM: number,
    scoringOpts: ProspectivityOptions,
    packData: PackData | undefined,
    query?: GeoContextQueryFn,
  ): Promise<ExplorationTarget | null> {
    const centre = this.h3.cellCentre(cell);
    const distanceM = haversineM(from, centre);
    const run = query ?? ((lat, lng, opts) => this.geo.contextAt(lat, lng, opts));
    const { context } = await run(centre.lat, centre.lng, { radiusM });
    const scored = prospectivityEvidence(context, radiusM, this.local, packData, scoringOpts, this.packOps);
    const score = computeConfidence(collapseGroups(scored)).score;
    const reportScore = reportProspectivity(
      scored.map((s) => ({ weight: s.item.weight, tier: s.item.tier, role: s.role, group: s.group })),
    );
    const reasons = reasonsFor(context, scored);
    if (reasons.length === 0) return null;
    const bearing = bearingDeg(from, centre);
    return {
      cell, centre, bearingDeg: bearing, compass: compassPoint(bearing),
      distanceM, score, reportScore, band: bandFor(score), reasons,
      commodities: commoditiesOf(context),
      coverage: coverageFor(packData, this.packOps, scored, centre),
      scoredForCommodity: scoringOpts.commodity ?? null,
      evidence: scored,
    };
  }

  /**
   * A target at a place the USER named, at ANY distance. No ring, no distance
   * cap, no minimum score: the engine's opinion is reported, not used as a gate.
   */
  async targetAt(
    from: { lat: number; lng: number },
    at: { lat: number; lng: number },
    opts: TargetingOptions = {},
  ): Promise<ExplorationTarget | null> {
    const radiusM = opts.radiusM ?? DEFAULT_CONTEXT_RADIUS_M;
    const packData = this.pack?.();
    return this.buildTarget(
      this.h3.cellFor(at.lat, at.lng), from, radiusM,
      { commodity: opts.commodity ?? null }, packData,
    );
  }

  async rank(lat: number, lng: number, opts: TargetingOptions = {}): Promise<TargetingResult> {
    const o = { ...DEFAULT_TARGETING, ...opts };
    const here = this.h3.cellFor(lat, lng);
    const radiusM = opts.radiusM ?? DEFAULT_CONTEXT_RADIUS_M;
    const candidates = this.h3.kRing(here, o.rings).filter((c) => c !== here);

    const done = this.perf.markPhase?.(`targeting.rank[${candidates.length + 1}]`) ?? (() => {});
    try {
      const query = await this.geo.openBatch();

      const currentResult = await query(lat, lng, { radiusM });
      const packData = this.pack?.();
      const scoringOpts: ProspectivityOptions = { commodity: opts.commodity ?? null };
      const currentScored = prospectivityEvidence(
        currentResult.context, radiusM, this.local, packData, scoringOpts, this.packOps,
      );
      const currentScore = computeConfidence(collapseGroups(currentScored)).score;
      const currentCoverage = coverageFor(packData, this.packOps, currentScored, { lat, lng });

      const targets: ExplorationTarget[] = [];

      let sinceYield = 0;
      const YIELD_EVERY_CELLS = 4;
      for (const cell of candidates) {
        const built = await this.buildTarget(cell, { lat, lng }, radiusM, scoringOpts, packData, query);
        if (++sinceYield >= YIELD_EVERY_CELLS) {
          sinceYield = 0;
          if (this.perf.yieldToFrame) await this.perf.yieldToFrame();
        }
        if (!built) continue;
        if (built.distanceM > o.maxDistanceM) continue;
        if (built.score < o.minScore) continue; // nothing indicating mineralisation
        targets.push(built);
      }

      targets.sort((a, b) => (b.score - a.score) || (a.distanceM - b.distanceM));

      const best = targets[0];
      return {
        current: {
          cell: here, context: currentResult.context,
          score: currentScore, coverage: currentCoverage,
        },
        targets: targets.slice(0, o.limit),
        hasKnowledge: currentResult.hasKnowledge,
        bestIsHere: !best || currentScore >= best.score,
      };
    } finally {
      done();
    }
  }
}
