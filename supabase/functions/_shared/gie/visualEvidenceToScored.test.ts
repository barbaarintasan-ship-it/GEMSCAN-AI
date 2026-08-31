// aiVisualToScoredEvidence — the vision→SCORING converter. Distinct from
// visionFindings.ts's converter (which produces the report's VISUAL EVIDENCE
// rows); this one feeds the Integrated Prospectivity Score.
//
//   deno test supabase/functions/_shared/gie/visualEvidenceToScored.test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { aiVisualToScoredEvidence } from "./visualEvidenceToScored.ts";
import { INTEGRATED_TIER_WEIGHT } from "../../../../shared/geo-core/gie/integratedProspectivity.ts";
import type { VisualObservation } from "./vision.ts";

function obs(over: Partial<VisualObservation> = {}): VisualObservation {
  return { statement: "seen", statementSo: "la arkay", aspect: "mineral", clarity: 1, ...over };
}

Deno.test("every item is tagged the ai_visual tier — never anything stronger", () => {
  const items = aiVisualToScoredEvidence([obs({ aspect: "vein" }), obs({ aspect: "other" })], "cell1");
  for (const i of items) assertEquals(i.tier, "ai_visual");
});

Deno.test("weight is bounded — clarity 1 on the strongest aspect never approaches the ai claim", () => {
  const items = aiVisualToScoredEvidence([obs({ aspect: "mineral", clarity: 1 })], "cell1");
  // 0.5 (ceiling) * 0.6 (mineral base) = 0.3 item weight, well short of 1.
  assertEquals(items[0].weight <= 0.3, true);
  assertEquals(items[0].weight * INTEGRATED_TIER_WEIGHT.ai_visual <= 0.12, true);
});

Deno.test("items anchor to the SAME siteAnchorId — the target cell, not the mission", () => {
  const items = aiVisualToScoredEvidence([obs()], "877a1c723ffffff");
  assertEquals(items[0].group.includes("877a1c723ffffff"), true);
});

Deno.test("a quartz statement refines to the quartz_vein group, keyword-matched", () => {
  const items = aiVisualToScoredEvidence(
    [obs({ aspect: "vein", statement: "White quartz vein" })], "cell1",
  );
  assertEquals(items[0].group, "evidence:cell1:quartz_vein");
});

Deno.test("an unmatched statement falls back to its aspect bucket, not lumped with 'other'", () => {
  const items = aiVisualToScoredEvidence(
    [obs({ aspect: "structure", statement: "fractured outcrop face" })], "cell1",
  );
  assertEquals(items[0].group, "evidence:cell1:structure");
});

Deno.test("imageQuality scales down every item, below the ceiling", () => {
  // clarity 1 at imageQuality 1 hits the 0.5 ceiling either way, so this picks
  // an imageQuality low enough to actually move the result below it.
  const full = aiVisualToScoredEvidence([obs({ clarity: 1 })], "cell1", 1)[0].weight;
  const low = aiVisualToScoredEvidence([obs({ clarity: 1 })], "cell1", 0.2)[0].weight;
  assertEquals(low < full, true);
});

Deno.test("role is metadata only — never read by the scorer, but always present", () => {
  const items = aiVisualToScoredEvidence([obs()], "cell1");
  assertEquals(typeof items[0].role, "string");
  assertEquals(items[0].role.length > 0, true);
});

Deno.test("empty observations produce an empty list, not a fabricated item", () => {
  assertEquals(aiVisualToScoredEvidence([], "cell1"), []);
});
