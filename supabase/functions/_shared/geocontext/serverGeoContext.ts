// Server-side GeoContextBatchSource — the adapter that lets the SHARED
// TargetingEngine/hotspotIn (shared/geo-core/gie/) run against the production
// Supabase gateway, instead of mobile's bundled offline pack.
//
// Solo→Team shared-targeting Phase 1. Mirrors mobile/lib/geo/offlineGeoContext.ts
// exactly at the seam TargetingEngine actually depends on (`contextAt`/
// `openBatch`) — same GeoContextEngine, same buildProviders() 7-provider suite,
// same query shape. No scoring logic lives here; this is wiring only, same as
// the mobile file it mirrors.
//
// WHAT'S DIFFERENT FROM SOLO'S CONTEXT (documented, not hidden):
//   - No pack-derived structural/terrain/lithology-prior evidence yet
//     (`makeMapLayerProvider`/`makeTerrainProvider` are mobile-only — see
//     prospectivityEvidence.ts's header note). Team gets occurrence,
//     association, community, geology-unit and field/local evidence today;
//     structural/terrain/lithology await a live server-side pack equivalent
//     (tracked separately, not part of Phase 1).
//   - `hasKnowledge` is always `true`: the server has no "pack not installed"
//     state the way an offline device does — it always queries the live
//     `geo` schema.
import { GeoContextEngine } from "./engine.ts";
import { buildProviders } from "./providers/index.ts";
import { makeSupabaseGateway } from "./providers/supabaseGateway.ts";
import { makeSupabaseCacheStore } from "./cacheStore.ts";
import { cellFor } from "./h3.ts";
import type { GeoContext, GeoQuery } from "./types.ts";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import type {
  GeoContextBatchSource, GeoContextQueryFn,
} from "../../../../shared/geo-core/gie/targetingEngine.ts";

export const TEAM_TARGETING_ENGINE_VERSION = "team-targeting-1.0.0";
const CACHE_TTL_S = 86400;

/**
 * Builds a `GeoContextBatchSource` (the same minimal interface Solo's
 * `OfflineGeoContextService` satisfies) over the production gateway. One
 * engine per call — `openBatch()` shares it across every candidate cell in a
 * single `rank()` call, exactly like Solo's own batching.
 */
export function makeServerGeoContext(client: SupabaseClient<any, any>): GeoContextBatchSource {
  const engine = new GeoContextEngine({
    engineVersion: TEAM_TARGETING_ENGINE_VERSION,
    providers: buildProviders(makeSupabaseGateway(client)),
    cache: makeSupabaseCacheStore(client),
    cacheTtlSeconds: CACHE_TTL_S,
  });

  const query: GeoContextQueryFn = async (lat, lng, opts = {}) => {
    const q: GeoQuery = {
      lat, lng,
      radiusM: opts.radiusM ?? 25_000,
      h3: cellFor(lat, lng),
    };
    const context: GeoContext = await engine.run(q);
    return { context, hasKnowledge: true };
  };

  return {
    contextAt: (lat, lng, opts) => query(lat, lng, opts),
    openBatch: () => Promise.resolve(query),
  };
}
