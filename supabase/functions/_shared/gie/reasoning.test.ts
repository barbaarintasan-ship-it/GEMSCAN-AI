// Unit tests for the GIE REASON + SCORE + ASSEMBLE stages (pure; no AI/DB).
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildReasoningPrompt, parseReasoningResponse, runReasoning, type ReasoningDeps } from "./reasoning.ts";
import { edgeWeight, scoreConclusion, tierWeight } from "./scoring.ts";
import { assembleAssessment } from "./assemble.ts";
import type { EvidenceNode, EvidenceSet } from "./types.ts";

const NODES: EvidenceNode[] = [
  { id: "e1", source: "field_sample", evType: "field", statement: "Host rock: granite", isObservation: true, tier: "field_observation", quality: 0.9 },
  { id: "e2", source: "occurrence", evType: "occurrence", statement: "Au occurrence 320 m", isObservation: false, tier: "mapped", quality: 0.7 },
  { id: "e3", source: "gemini_vision", evType: "visual", statement: "quartz veining", isObservation: true, tier: "ai_visual", quality: 0.6 },
];
const SET: EvidenceSet = { nodes: NODES, providersRun: ["occurrence"], providersFailed: [], countsByType: { field: 1, visual: 1, spatial: 0, occurrence: 1, knowledge: 0, association: 0, prior_sample: 0 } };

const GOOD_JSON = JSON.stringify({
  conclusions: [
    { kind: "rock_type", statement: "Granite host", is_interpretation: true,
      supporting: [{ evidence_id: "e1", contribution: 0.8 }, { evidence_id: "e3", contribution: 0.5 }], contradicting: [] },
    { kind: "mineralization", statement: "Possible Au-bearing quartz vein", is_interpretation: true,
      supporting: [{ evidence_id: "e2", contribution: 0.7 }, { evidence_id: "e3", contribution: 0.6 }], contradicting: [] },
    { kind: "deposit_model", statement: "Orphan claim", is_interpretation: true,
      supporting: [{ evidence_id: "e999", contribution: 0.9 }], contradicting: [] }, // invalid id → dropped
  ],
  uncertainties: ["strike/dip not measured"],
  missing_information: ["fresh-surface photo"],
  recommendations: [
    { action: "collect another sample ~2 m along vein", scale_m: 2, evidence_ids: ["e2", "e3"] },
    { action: "drill 80 m step-out", scale_m: 80, evidence_ids: ["e2"] }, // over-reach (1 group) → flagged
  ],
});

Deno.test("buildReasoningPrompt lists evidence + forbids confidence numbers", () => {
  const p = buildReasoningPrompt(NODES, "granite, quartz");
  assert(p.includes("[e1]") && p.includes("[e2]"));
  assert(/do not output any confidence/i.test(p));
});

Deno.test("parseReasoningResponse validates kinds + links", () => {
  const out = parseReasoningResponse(GOOD_JSON);
  assertEquals(out.conclusions.length, 3); // parse keeps all; assemble drops the orphan
  assertEquals(out.conclusions[0].kind, "rock_type");
  assertEquals(out.recommendations.length, 2);
});
Deno.test("parseReasoningResponse drops bad kinds + garbage", () => {
  const out = parseReasoningResponse(JSON.stringify({ conclusions: [{ kind: "nonsense", statement: "x", supporting: [] }] }));
  assertEquals(out.conclusions.length, 0);
  assertEquals(parseReasoningResponse("not json").conclusions.length, 0);
});

Deno.test("tierWeight/edgeWeight: ai_visual is weak, field is strong", () => {
  assert(tierWeight("field_observation") > tierWeight("ai_visual"));
  const byId = new Map(NODES.map((n) => [n.id, n]));
  const wField = edgeWeight({ evidenceId: "e1", contribution: 1 }, byId.get("e1"));
  const wVisual = edgeWeight({ evidenceId: "e3", contribution: 1 }, byId.get("e3"));
  assert(wField > wVisual);
});

Deno.test("scoreConclusion: multi-group evidence beats single-group cap", () => {
  const byId = new Map(NODES.map((n) => [n.id, n]));
  // single group (visual only) is capped at 0.6 → ≤60
  const single = scoreConclusion({ kind: "rock_type", statement: "x", statementSo: "x", isInterpretation: true,
    supporting: [{ evidenceId: "e3", contribution: 0.9 }], contradicting: [] }, byId);
  assert(single.confidence <= 60);
  // two groups (field + occurrence) not capped → higher
  const multi = scoreConclusion({ kind: "rock_type", statement: "x", statementSo: "x", isInterpretation: true,
    supporting: [{ evidenceId: "e1", contribution: 0.9 }, { evidenceId: "e2", contribution: 0.8 }], contradicting: [] }, byId);
  assert(multi.confidence > single.confidence);
});

Deno.test("assembleAssessment drops orphan conclusions + flags over-reach + computes confidence", () => {
  const a = assembleAssessment(SET, parseReasoningResponse(GOOD_JSON));
  assertEquals(a.conclusions.length, 2);       // orphan (e999) dropped
  assertEquals(a.droppedConclusions, 1);
  assert(a.overallConfidence > 0 && a.overallConfidence <= 100);
  // every kept conclusion has ≥1 supporting edge (invariant)
  assert(a.conclusions.every((c) => c.edges.some((e) => e.polarity === "supporting")));
  const rec80 = a.report.recommendations.find((r) => r.scaleM === 80)!;
  assertEquals(rec80.flagged, true);           // 80 m with one dataset group → flagged
  const rec2 = a.report.recommendations.find((r) => r.scaleM === 2)!;
  assertEquals(rec2.flagged, false);
});

Deno.test("runReasoning uses injected generate", async () => {
  const deps: ReasoningDeps = { generate: () => Promise.resolve(GOOD_JSON) };
  const out = await runReasoning(NODES, "granite", deps);
  assertEquals(out.conclusions.length, 3);
});
