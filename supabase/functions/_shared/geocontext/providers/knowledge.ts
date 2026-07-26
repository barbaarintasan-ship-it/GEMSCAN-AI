// KnowledgeProvider (Category B, priority 30) — extracted facts from historical
// reports (Greenwood/GEOSOM/UNDP/IAEA) near the point. Never parses PDFs at runtime;
// reads the pre-normalized geo.geological_knowledge (via knowledge_near RPC).
import type { DatasetRef, GeoContextProvider, GeoQuery, ProviderContribution } from "../types.ts";
import type { GeoDataGateway } from "./gateway.ts";

// Report evidence is weighted by tier; extraction confidence handled upstream.
const TIER_BASE: Record<string, number> = { historical: 0.55, mapped: 0.7, expert_verified: 0.85, lab_verified: 0.95 };

export function makeKnowledgeProvider(gw: GeoDataGateway): GeoContextProvider {
  return {
    name: "knowledge",
    category: "knowledge",
    priority: 30,
    async fetch(q: GeoQuery): Promise<ProviderContribution> {
      const rows = await gw.knowledgeNear(q.lat, q.lng, q.radiusM);
      const evidence = rows.map((r) => ({
        statement: `${r.statement} (${r.dataset_source}${r.page ? `, p.${r.page}` : ""})`,
        weight: TIER_BASE[r.tier ?? "historical"] ?? 0.55,
        tier: r.tier ?? "historical",
        provenance: {
          source: r.dataset_source, datasetVersion: r.dataset_version ?? undefined,
          reference: r.source_title ?? undefined, page: r.page ?? undefined,
        },
      }));
      const datasets: DatasetRef[] = [...new Map(
        rows.map((r) => [r.dataset_id, { datasetId: r.dataset_id, source: r.dataset_source, version: r.dataset_version ?? undefined }]),
      ).values()];
      return {
        provider: "knowledge",
        category: "knowledge",
        priority: 30,
        data: {
          historicalReports: rows.map((r) => ({
            source: r.dataset_source, observation: r.statement, kind: r.kind,
            reference: r.source_title, page: r.page,
          })),
        },
        evidence,
        confidence: rows.length ? Math.max(...evidence.map((e) => e.weight)) : 0,
        datasets,
      };
    },
  };
}
