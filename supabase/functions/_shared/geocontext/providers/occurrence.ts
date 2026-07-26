// OccurrenceProvider (Category A, priority 20) — MRDS + extracted occurrences in radius.
import type { DatasetRef, GeoContextProvider, GeoQuery, ProviderContribution } from "../types.ts";
import type { GeoDataGateway } from "./gateway.ts";

// Nearer occurrences weigh more (linear falloff across the search radius).
function proximityWeight(distanceM: number, radiusM: number): number {
  const w = 1 - distanceM / Math.max(radiusM, 1);
  return Math.max(0.2, Math.min(0.9, w));
}

export function makeOccurrenceProvider(gw: GeoDataGateway): GeoContextProvider {
  return {
    name: "occurrence",
    category: "spatial",
    priority: 20,
    async fetch(q: GeoQuery): Promise<ProviderContribution> {
      const rows = await gw.occurrencesNear(q.lat, q.lng, q.radiusM);
      const evidence = rows.map((r) => ({
        statement: `${r.commodity_key ?? "Mineral"} occurrence ${Math.round(Number(r.distance_m))} m` +
          `${r.deposit_type ? ` (${r.deposit_type})` : ""} — ${r.source}`,
        weight: proximityWeight(Number(r.distance_m), q.radiusM),
        tier: "mapped",
        provenance: { source: r.source, datasetVersion: r.version ?? undefined, reference: r.reference ?? undefined },
      }));
      const hostRocks = [...new Set(rows.flatMap((r) => r.host_rocks ?? []))];
      const datasets: DatasetRef[] = [...new Map(
        rows.map((r) => [r.dataset_id, { datasetId: r.dataset_id, source: r.source, version: r.version ?? undefined }]),
      ).values()];
      return {
        provider: "occurrence",
        category: "spatial",
        priority: 20,
        data: {
          knownOccurrences: rows.map((r) => ({
            commodity: r.commodity_key, depositType: r.deposit_type,
            distanceM: Math.round(Number(r.distance_m)), source: r.source, reference: r.reference,
          })),
          hostRocks,
        },
        evidence,
        confidence: rows.length ? Math.max(...evidence.map((e) => e.weight)) : 0,
        datasets,
      };
    },
  };
}
