// MineralAssociationProvider (Category B/knowledge, priority 40) — EMIE upgrade.
// Instead of a flat rock→mineral map, it reads mineral ASSEMBLAGE rules: a set of
// co-occurring minerals implies a geological system/process (e.g. quartz + arsenopyrite
// → a possible gold-bearing hydrothermal system). Keyed off the sample's observed
// minerals (field + optional AI hint). Weak evidence (tier knowledge_kb); it interprets,
// it never asserts.
import type { GeoContextProvider, GeoQuery, ProviderContribution } from "../types.ts";
import type { GeoDataGateway } from "./gateway.ts";

const TIER = "knowledge_kb";

function epistemicFor(likelihood: string): "inferred" | "possible" {
  return likelihood === "diagnostic" || likelihood === "common" ? "inferred" : "possible";
}

export function makeMineralAssociationProvider(gw: GeoDataGateway): GeoContextProvider {
  return {
    name: "mineral_association",
    category: "knowledge",
    priority: 40,
    async fetch(q: GeoQuery): Promise<ProviderContribution> {
      const minerals = [...new Set(
        [...(q.sample?.minerals ?? []), ...(q.mineralHint ? [q.mineralHint] : [])]
          .map((m) => (m ?? "").trim().toLowerCase()).filter(Boolean),
      )];
      if (minerals.length === 0) {
        return { provider: "mineral_association", category: "knowledge", priority: 40, data: {}, evidence: [], confidence: 0, datasets: [] };
      }

      const rules = await gw.assemblageRulesFor(minerals);
      const evidence = rules.map((r) => ({
        statement: r.relationship,
        weight: clamp(Number(r.weight) || 0.35),
        tier: TIER,
        provenance: {
          source: "Mineral association KB",
          reference: r.commodity_code ?? undefined,
          quote: JSON.stringify({
            epistemic: epistemicFor(r.likelihood), likelihood: r.likelihood,
            interpretation: r.interpretation, commodity: r.commodity_code,
            minerals: r.minerals, kind: "assemblage",
          }),
        },
      }));

      return {
        provider: "mineral_association",
        category: "knowledge",
        priority: 40,
        data: {
          commodityAssociations: rules.map((r) => ({
            setting: r.interpretation, commodity: r.commodity_code, minerals: r.minerals, likelihood: r.likelihood,
          })),
        },
        evidence,
        confidence: evidence.length ? Math.min(0.5, Math.max(...evidence.map((e) => e.weight))) : 0,
        datasets: [{ source: "Mineral association KB" }],
      };
    },
  };
}

function clamp(n: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));
}
