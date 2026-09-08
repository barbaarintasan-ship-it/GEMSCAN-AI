// EMIE knowledge providers — unit tests with a fake gateway (no DB).
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { makeGeologicalKnowledgeProvider } from "./geologicalKnowledge.ts";
import { makeMineralAssociationProvider } from "./mineralAssociation.ts";
import type { GeoDataGateway } from "./gateway.ts";

const emptyGw: GeoDataGateway = {
  geologyAt: () => Promise.resolve([]),
  occurrencesNear: () => Promise.resolve([]),
  knowledgeNear: () => Promise.resolve([]),
  communityNear: () => Promise.resolve({ verified_scans: 0, sample_count: 0, cell_count: 0 }),
  associationsForHostRocks: () => Promise.resolve([]),
  knowledgeRulesFor: () => Promise.resolve([]),
  commodityProfiles: () => Promise.resolve([]),
  assemblageRulesFor: () => Promise.resolve([]),
  structuralFeaturesNear: () => Promise.resolve([]),
};
const q = { lat: 2, lng: 45, radiusM: 25000 };

Deno.test("geological_knowledge: kimberlite host rock → relationship + economic + limitation evidence", async () => {
  const gw: GeoDataGateway = {
    ...emptyGw,
    knowledgeRulesFor: (k) => {
      assert(k.hostRocks.includes("kimberlite"));
      return Promise.resolve([{
        id: "r1", antecedent_type: "host_rock", antecedent_key: "kimberlite", commodity_code: "diamond",
        expected_minerals: ["diamond", "pyrope garnet"], relationship: "Kimberlite can carry diamond to surface.",
        likelihood: "common", requires_setting: ["craton"], weight: 0.4,
      }]);
    },
    commodityProfiles: () => Promise.resolve([{
      code: "diamond", name: "Diamond", category: "gemstone", typical_host_rocks: null, associated_minerals: null,
      alteration_styles: null, deposit_models: null, tectonic_settings: null, exploration_indicators: null,
      industrial_uses: ["cutting", "abrasives"], is_critical_mineral: false,
      strategic_importance: "Diamond is a critical industrial abrasive and the ultimate gemstone.",
      confidence_limitations: "Not every kimberlite is diamond-bearing.",
    }]),
  };
  const c = await makeGeologicalKnowledgeProvider(gw).fetch({ ...q, sample: { hostRocks: ["kimberlite"] } });
  assertEquals(c.provider, "geological_knowledge");
  // relationship + strategic_importance + limitation = 3 evidence items
  assertEquals(c.evidence.length, 3);
  assert(c.evidence.some((e) => e.statement.includes("diamond to surface")));
  assert(c.evidence.some((e) => e.statement.includes("Not every kimberlite")));
  // knowledge is weak + capped
  assert(c.confidence <= 0.5);
  // epistemic is carried in provenance.quote for the gather stage to lift
  const rel = c.evidence[0].provenance as { quote?: string };
  assert(JSON.parse(rel.quote!).epistemic === "inferred"); // 'common' → inferred
});

Deno.test("geological_knowledge: no rock context → no evidence", async () => {
  const c = await makeGeologicalKnowledgeProvider(emptyGw).fetch(q);
  assertEquals(c.evidence.length, 0);
  assertEquals(c.confidence, 0);
});

// The three STRONG host-rock rules added in migration 0109. This proves the LIVE
// GeologicalKnowledgeProvider turns each seeded rule (as knowledge_rules_for
// returns it) into relationship evidence AND a commodityAssociation carrying the
// commodity and its expected minerals — i.e. the rows are actually consumed.
Deno.test("geological_knowledge: 0109 host-rock rules are consumed into evidence + commodityAssociations", async () => {
  const NEW_RULES = [
    { key: "lamproite", commodity: "diamond", minerals: ["diamond", "pyrope garnet", "chromite", "olivine"],
      relationship: "Lamproite can carry diamond to the surface like kimberlite." },
    { key: "sandstone", commodity: "uranium", minerals: ["uraninite", "coffinite", "carnotite"],
      relationship: "Roll-front uranium precipitates in reduced permeable sandstone." },
    { key: "pegmatite", commodity: "tourmaline", minerals: ["tourmaline", "elbaite", "rubellite"],
      relationship: "Evolved LCT pegmatites host gem tourmaline alongside lithium and tantalum." },
  ];

  for (const nr of NEW_RULES) {
    const gw: GeoDataGateway = {
      ...emptyGw,
      knowledgeRulesFor: (k) => {
        // The provider must query with the derived host-rock term for the rule to match.
        assert(k.hostRocks.includes(nr.key), `provider queried host rock ${nr.key}`);
        return Promise.resolve([{
          id: `r-${nr.key}`, antecedent_type: "host_rock", antecedent_key: nr.key,
          commodity_code: nr.commodity, expected_minerals: nr.minerals,
          relationship: nr.relationship, likelihood: "common", requires_setting: [], weight: 0.4,
        }]);
      },
      commodityProfiles: (codes) => Promise.resolve(codes.map((code) => ({
        code, name: code, category: "test", typical_host_rocks: null, associated_minerals: null,
        alteration_styles: null, deposit_models: null, tectonic_settings: null,
        exploration_indicators: null, industrial_uses: null, is_critical_mineral: false,
        strategic_importance: `${code} is strategically important.`,
        confidence_limitations: `${code} needs field confirmation.`,
      }))),
    };

    const c = await makeGeologicalKnowledgeProvider(gw).fetch({ ...q, sample: { hostRocks: [nr.key] } });

    // 1. the rule's relationship became evidence (the provider read the row)
    assert(c.evidence.some((e) => e.statement === nr.relationship),
      `relationship evidence emitted for ${nr.key} → ${nr.commodity}`);

    // 2. the commodityAssociation carries the commodity, its host-rock setting and expected minerals
    const assocs = (c.data as {
      commodityAssociations?: Array<{ setting: string; commodity: string | null; expectedMinerals: string[] }>;
    }).commodityAssociations ?? [];
    const match = assocs.find((a) => a.commodity === nr.commodity);
    assert(match, `commodityAssociation produced for ${nr.commodity}`);
    assertEquals(match!.setting, nr.key);
    assertEquals(match!.expectedMinerals, nr.minerals);
  }
});

Deno.test("mineral_association: quartz + arsenopyrite → possible gold system", async () => {
  const gw: GeoDataGateway = {
    ...emptyGw,
    assemblageRulesFor: (m) => {
      assert(m.includes("arsenopyrite"));
      return Promise.resolve([{
        id: "a1", minerals: ["quartz", "arsenopyrite"], interpretation: "Possible gold-bearing hydrothermal system",
        commodity_code: "gold", likelihood: "possible", relationship: "Arsenopyrite is a pathfinder for gold.", weight: 0.36,
      }]);
    },
  };
  const c = await makeMineralAssociationProvider(gw).fetch({ ...q, sample: { minerals: ["Quartz", "Arsenopyrite"] } });
  assertEquals(c.evidence.length, 1);
  assert(c.evidence[0].statement.includes("pathfinder for gold"));
  assert(JSON.parse((c.evidence[0].provenance as { quote: string }).quote).epistemic === "possible");
});
