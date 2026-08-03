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
import type { GeoContext, GeoQuery } from "../../../shared/geo-core/types.ts";
import { makePackGateway } from "./packGateway.ts";
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

/**
 * Runs the geological context for a position, entirely on the device.
 *
 * The engine is constructed per query from the store's current data, so a pack
 * activated mid-session is picked up without restarting anything. No cache is
 * passed: the server's cache exists to avoid repeat provider I/O, and here the
 * providers read an in-memory pack.
 */
export class OfflineGeoContextService {
  constructor(
    private readonly packs: PackStore,
    private readonly engineVersion = "1.0.0",
  ) {}

  /** H3 cell for a position — the key the exploration loop re-targets on (§3.4). */
  cellFor(lat: number, lng: number): string {
    return cellFor(lat, lng, H3_RESOLUTION);
  }

  async contextAt(
    lat: number,
    lng: number,
    opts: { radiusM?: number; sample?: GeoQuery["sample"]; mineralHint?: string } = {},
  ): Promise<OfflineContextResult> {
    await this.packs.load();

    const gateway = makePackGateway(this.packs.getData());
    const engine = new GeoContextEngine({
      providers: buildProviders(gateway),
      engineVersion: this.engineVersion,
    });

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
  }
}
