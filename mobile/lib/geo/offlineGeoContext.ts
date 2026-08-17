// Offline GeoContext — workflow step 2, "where am I and what is here?" (E2).
//
// This is the whole point of the migration: the SAME engine and the SAME 7
// providers the server runs, executing on the phone against a knowledge pack.
// Nothing is reimplemented here — this file is wiring.
//
//   GeoQuery → PackGateway → 7 providers → fusion/confidence → GeoContext
//
// The result has the same shape the server produces, which is what makes the
// E3 differential comparison possible at all.
import { GeoContextEngine } from "../../../supabase/functions/_shared/geocontext/engine.ts";
import { buildProviders } from "../../../supabase/functions/_shared/geocontext/providers/index.ts";
import { cellFor, H3_RESOLUTION } from "./h3.ts";
import type { GeoContext, GeoContextProvider, GeoQuery } from "../../../shared/geo-core/types.ts";
import { makePackGateway } from "./packGateway.ts";
import { makeMapLayerProvider, makeTerrainProvider } from "./terrainProviders.ts";
import type { PackStore } from "./packStore.ts";

/** Default search radius for "what is around me", matching the server's usage. */
export const DEFAULT_CONTEXT_RADIUS_M = 10_000;

export interface OfflineContextResult {
  context: GeoContext;
  /** Which pack answered, and how old it is — surfaced with every recommendation (§3.9). */
  provenance: { packVersion: string; builtAt: string; ageDays: number; stale: boolean } | null;
  /** False when no pack is installed: the app says it has no knowledge here. */
  hasKnowledge: boolean;
}

/** One position, scored against whichever engine/gateway `openBatch()` built. */
export type GeoContextQuery = (
  lat: number,
  lng: number,
  opts?: { radiusM?: number; sample?: GeoQuery["sample"]; mineralHint?: string },
) => Promise<OfflineContextResult>;

/**
 * Runs the geological context for a position, entirely on the device.
 *
 * The engine is constructed per query from the store's current data, so a pack
 * activated mid-session is picked up without restarting anything. No cache is
 * passed: the server's cache exists to avoid repeat provider I/O, and here the
 * providers read an in-memory pack.
 */
export class OfflineGeoContextService {
  /**
   * `extraProviders` is how the local evidence overlay joins in (Architecture
   * §9). It is appended to the pack providers rather than replacing any, so a
   * geologist's own observations are fused with published knowledge by the same
   * engine, and the two stay distinguishable by tier and provenance.
   */
  constructor(
    private readonly packs: PackStore,
    private readonly engineVersion = "1.0.0",
    private readonly extraProviders: GeoContextProvider[] = [],
  ) {}

  /** H3 cell for a position — the key the exploration loop re-targets on (§3.4). */
  cellFor(lat: number, lng: number): string {
    return cellFor(lat, lng, H3_RESOLUTION);
  }

  /**
   * Build the engine once and hand back a function that queries it as many
   * times as the caller needs — the SAME providers and the SAME gateway,
   * over the SAME pack snapshot, for every position.
   *
   * `rank()` used to get this by calling `contextAt()` once per candidate
   * cell — up to 1 + kRing(rings) times per ranking, 37 for the default 3
   * rings — and `contextAt()` rebuilt the engine and gateway from scratch
   * every time. Rebuilding is cheap; what is not cheap is that several
   * providers (map layers, terrain, and prospectivityEvidence's own structural
   * and drainage checks in targeting.ts) scan the FULL mapFeatures array —
   * 18,504 rows in the current pack — with no spatial index. Measured on an
   * SM-A165F: ~37 of those scans back to back is tens of seconds of the JS
   * thread doing nothing else, which is why cold start and every GPS-driven
   * re-target could freeze the app for 50+ seconds with no network call, no
   * timeout, and no open markPhase to blame (see targeting.ts rank()).
   *
   * This changes nothing about WHAT is computed — same providers, same
   * gateway methods, same query shape per cell, so scoring output is
   * unchanged (targeting.test.ts "ranking is deterministic" and the rest of
   * that suite pin this down). It only shares the construction cost across
   * every position scored in the same batch instead of paying it per cell.
   */
  async openBatch(): Promise<GeoContextQuery> {
    await this.packs.load();

    const gateway = makePackGateway(this.packs.getData());
    // Map layers and terrain read the pack directly rather than through the
    // gateway: the gateway mirrors the server's 9 SQL functions, and inventing
    // two more would put the device ahead of the contract E3 compares against.
    const packData = () => this.packs.getData();
    const engine = new GeoContextEngine({
      providers: [
        ...buildProviders(gateway),
        makeMapLayerProvider(packData),
        makeTerrainProvider(packData),
        ...this.extraProviders,
      ],
      engineVersion: this.engineVersion,
    });

    return async (lat, lng, opts = {}) => {
      const query: GeoQuery = {
        lat,
        lng,
        radiusM: opts.radiusM ?? DEFAULT_CONTEXT_RADIUS_M,
        h3: this.cellFor(lat, lng),
        ...(opts.mineralHint ? { mineralHint: opts.mineralHint } : {}),
        ...(opts.sample ? { sample: opts.sample } : {}),
      };

      return {
        context: await engine.run(query),
        provenance: this.packs.provenance(),
        hasKnowledge: this.packs.isReady(),
      };
    };
  }

  /**
   * One position, one query. Built on `openBatch()` so a single-shot caller
   * (targetAt, useGeoReadout, this file's own tests) and a batch caller
   * (rank()) run through the exact same code — there is no second
   * implementation to drift out of sync with this one.
   */
  async contextAt(
    lat: number,
    lng: number,
    opts: { radiusM?: number; sample?: GeoQuery["sample"]; mineralHint?: string } = {},
  ): Promise<OfflineContextResult> {
    const query = await this.openBatch();
    return query(lat, lng, opts);
  }
}
