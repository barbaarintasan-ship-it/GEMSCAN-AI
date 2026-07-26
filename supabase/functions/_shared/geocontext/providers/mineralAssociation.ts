// MineralAssociationProvider (Category B/knowledge, priority 40) — the queryable
// commodity-association KB. It derives the local host-rock context from nearby
// occurrences, then returns weighted commodity associations for those host rocks.
import type { GeoContextProvider, GeoQuery, ProviderContribution } from "../types.ts";
import type { GeoDataGateway } from "./gateway.ts";

export function makeMineralAssociationProvider(gw: GeoDataGateway): GeoContextProvider {
  return {
    name: "mineral_association",
    category: "knowledge",
    priority: 40,
    async fetch(q: GeoQuery): Promise<ProviderContribution> {
      // Local host-rock context from nearby occurrences.
      const occ = await gw.occurrencesNear(q.lat, q.lng, q.radiusM);
      const hostRocks = [...new Set(occ.flatMap((r) => r.host_rocks ?? []))];
      if (hostRocks.length === 0) {
        return { provider: "mineral_association", category: "knowledge", priority: 40, data: {}, evidence: [], confidence: 0, datasets: [] };
      }
      const assoc = await gw.associationsForHostRocks(hostRocks);
      const w = (x: number | null): number | null => (x == null ? null : Number(x));
      const evidence = assoc.map((a) => ({
        statement: `${a.host_rock_code} favors ${a.commodity_code}` +
          (a.weight != null ? ` (association weight ${w(a.weight)})` : ""),
        weight: Math.max(0.2, Math.min(0.8, w(a.weight) ?? 0.4)),
        tier: "mapped",
        provenance: { source: "Mineral association KB" },
      }));
      return {
        provider: "mineral_association",
        category: "knowledge",
        priority: 40,
        data: {
          commodityAssociations: assoc.map((a) => ({
            setting: a.host_rock_code, commodity: a.commodity_code, weight: w(a.weight),
          })),
        },
        evidence,
        confidence: evidence.length ? Math.max(...evidence.map((e) => e.weight)) : 0,
        datasets: [],
      };
    },
  };
}
