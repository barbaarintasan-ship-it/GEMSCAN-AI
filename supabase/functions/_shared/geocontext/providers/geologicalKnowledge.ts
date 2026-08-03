// GeologicalKnowledgeProvider (Category B/knowledge, priority 35) — the EMIE
// enrichment provider. Given the sample's rock/lithology/deposit context (from the
// query's sample block, the mapped geology at the point, and nearby occurrences), it
// looks up the geological knowledge rules + commodity profiles and emits EVIDENCE
// that explains what the rock/environment commonly hosts, why it matters industrially/
// strategically, and its honest limitations. It never asserts presence: every item is
// weak (tier knowledge_kb) and tagged epistemic possible|inferred, so it enriches
// reasoning without ever, alone, driving high confidence.
import type { GeoContextProvider, GeoQuery, ProviderContribution } from "../types.ts";
import type { GeoDataGateway, KnowledgeRuleRow } from "./gateway.ts";

const TIER = "knowledge_kb";
const MAX_RULES = 10;

// likelihood → epistemic status (knowledge is never "observed").
function epistemicFor(likelihood: string): "inferred" | "possible" {
  return likelihood === "diagnostic" || likelihood === "common" ? "inferred" : "possible";
}

function uniqLower(...lists: (string | null | undefined)[][]): string[] {
  const out = new Set<string>();
  for (const list of lists) for (const v of list) {
    const s = (v ?? "").trim().toLowerCase();
    if (s) out.add(s);
  }
  return [...out];
}

export function makeGeologicalKnowledgeProvider(gw: GeoDataGateway): GeoContextProvider {
  return {
    name: "geological_knowledge",
    category: "knowledge",
    priority: 35,
    async fetch(q: GeoQuery): Promise<ProviderContribution> {
      // Rock/lithology/deposit keys from three independent sources (parallel-safe).
      const [geology, occ] = await Promise.all([
        gw.geologyAt(q.lat, q.lng).catch(() => []),
        gw.occurrencesNear(q.lat, q.lng, q.radiusM).catch(() => []),
      ]);
      const hostRocks = uniqLower(q.sample?.hostRocks ?? [], occ.flatMap((o) => o.host_rocks ?? []));
      const lithology = uniqLower(q.sample?.lithology ?? [], geology.flatMap((g) => [g.name, g.kind]));
      const depositTypes = uniqLower(q.sample?.depositHints ?? [], occ.map((o) => o.deposit_type));

      if (hostRocks.length + lithology.length + depositTypes.length === 0) {
        return { provider: "geological_knowledge", category: "knowledge", priority: 35, data: {}, evidence: [], confidence: 0, datasets: [] };
      }

      const rules = (await gw.knowledgeRulesFor({ hostRocks, lithology, depositTypes })).slice(0, MAX_RULES);
      if (rules.length === 0) {
        return { provider: "geological_knowledge", category: "knowledge", priority: 35, data: {}, evidence: [], confidence: 0, datasets: [] };
      }

      const commodityCodes = [...new Set(rules.map((r) => r.commodity_code).filter((c): c is string => !!c))];
      const profiles = commodityCodes.length ? await gw.commodityProfiles(commodityCodes).catch(() => []) : [];
      const profileByCode = new Map(profiles.map((p) => [p.code, p]));

      const evidence: ProviderContribution["evidence"] = [];

      // 1. Relationship evidence — what this rock/environment commonly hosts, and WHY.
      for (const r of rules) {
        evidence.push({
          statement: r.relationship,
          weight: clamp(Number(r.weight) || 0.35),
          tier: TIER,
          provenance: {
            source: "Economic Mineral KB",
            reference: r.commodity_code ?? undefined,
            quote: JSON.stringify({
              epistemic: epistemicFor(r.likelihood),
              likelihood: r.likelihood,
              commodity: r.commodity_code,
              expectedMinerals: r.expected_minerals ?? [],
              requiresSetting: r.requires_setting ?? [],
              kind: "relationship",
            }),
          },
        });
      }

      // 2. Economic importance + honest limitation for each relevant commodity.
      for (const code of commodityCodes) {
        const p = profileByCode.get(code);
        if (!p) continue;
        if (p.strategic_importance) {
          evidence.push({
            statement: p.strategic_importance,
            weight: 0.3, tier: TIER,
            provenance: {
              source: "Economic Mineral KB", reference: code,
              quote: JSON.stringify({ epistemic: "possible", kind: "economic_importance", commodity: code, critical: !!p.is_critical_mineral, industrialUses: p.industrial_uses ?? [] }),
            },
          });
        }
        evidence.push({
          statement: p.confidence_limitations,
          weight: 0.2, tier: TIER,
          provenance: { source: "Economic Mineral KB", reference: code, quote: JSON.stringify({ epistemic: "possible", kind: "limitation", commodity: code }) },
        });
      }

      const maxW = Math.max(0, ...evidence.map((e) => e.weight));
      return {
        provider: "geological_knowledge",
        category: "knowledge",
        priority: 35,
        data: {
          commodityAssociations: rules.map((r: KnowledgeRuleRow) => ({
            setting: r.antecedent_key, commodity: r.commodity_code,
            expectedMinerals: r.expected_minerals ?? [], likelihood: r.likelihood,
          })),
        },
        evidence,
        // Knowledge is deliberately weak; cap its provider-local confidence.
        confidence: Math.min(0.5, maxW),
        datasets: [{ source: "Economic Mineral KB" }],
      };
    },
  };
}

function clamp(n: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));
}
