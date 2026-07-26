// CommunityProvider (Category A, priority 50) — aggregated community evidence near
// the point (coverage cells). Community only STRENGTHENS existing evidence; it is
// weighted low and is never used alone to drive a conclusion.
import type { GeoContextProvider, GeoQuery, ProviderContribution } from "../types.ts";
import type { GeoDataGateway } from "./gateway.ts";

export function makeCommunityProvider(gw: GeoDataGateway): GeoContextProvider {
  return {
    name: "community",
    category: "spatial",
    priority: 50,
    async fetch(q: GeoQuery): Promise<ProviderContribution> {
      const c = await gw.communityNear(q.lat, q.lng, q.radiusM);
      // Coerce defensively: count columns may arrive as bigint/string depending on
      // the transport (pg driver vs PostgREST).
      const verified = Number(c.verified_scans) || 0;
      const samples = Number(c.sample_count) || 0;
      const cells = Number(c.cell_count) || 0;
      const evidence = [];
      if (verified > 0) {
        evidence.push({
          statement: `${verified} community-verified observation(s) nearby`,
          weight: Math.min(0.5, 0.1 + verified * 0.05),
          tier: "community",
          provenance: { source: "Community observations" },
        });
      }
      return {
        provider: "community",
        category: "spatial",
        priority: 50,
        data: {
          communityEvidence: {
            verifiedScans: verified,
            clusterDensity: cells > 0 ? samples / cells : 0,
          },
        },
        evidence,
        confidence: evidence.length ? evidence[0].weight : 0,
        datasets: [],
      };
    },
  };
}
