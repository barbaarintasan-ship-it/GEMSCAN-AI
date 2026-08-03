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
