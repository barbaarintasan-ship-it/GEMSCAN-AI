// GeologyProvider (Category A, priority 10) — UNESCO geological layer at the point.
import type { GeoContextProvider, GeoQuery, ProviderContribution } from "../types.ts";
import type { GeoDataGateway } from "./gateway.ts";

export function makeGeologyProvider(gw: GeoDataGateway): GeoContextProvider {
  return {
    name: "geology",
    category: "spatial",
    priority: 10,
    async fetch(q: GeoQuery): Promise<ProviderContribution> {
      const rows = await gw.geologyAt(q.lat, q.lng);
      const evidence = rows.map((r) => ({
        statement: `Mapped as ${r.name}${r.kind ? ` (${r.kind})` : ""}`,
        weight: 0.85,
        tier: "mapped",
        provenance: { source: r.source ?? "UNESCO geological map" },
      }));
      const first = rows[0];
      const formations = rows
        .filter((r) => (r.kind ?? "").toLowerCase().includes("formation"))
        .map((r) => ({ name: r.name, source: r.source ?? "UNESCO" }));
      return {
        provider: "geology",
        category: "spatial",
        priority: 10,
        data: {
          geology: first ? { unit: first.name } : {},
          formations,
          lithology: rows.map((r) => ({ rockType: r.kind, name: r.name })),
        },
        evidence,
        confidence: rows.length ? 0.85 : 0,
        datasets: [...new Set(rows.map((r) => r.source ?? "UNESCO geological map"))]
          .map((source) => ({ source })),
      };
    },
  };
}
