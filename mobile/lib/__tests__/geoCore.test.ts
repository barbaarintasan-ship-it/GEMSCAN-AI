// Shared geological core — mobile-side proof (Stage E0).
//
// The point of this file is NOT to re-test logic the server already tests. It is
// to prove that `shared/geo-core` — written for Deno, imported with explicit
// `.ts` specifiers — actually RESOLVES, COMPILES and EXECUTES inside the React
// Native toolchain (Metro watchFolders + babel + jest-expo).
//
// The expected values below are computed by hand from the algorithms, so if the
// two runtimes ever disagree this test fails rather than drifting quietly. These
// same fixtures are the seed for the E3 differential suite.
import { TIER_WEIGHT, bandFor, computeConfidence } from "../../../shared/geo-core/confidence.ts";
import type { EvidenceItem } from "../../../shared/geo-core/types.ts";
import { edgeWeight, scoreConclusion, tierWeight } from "../../../shared/geo-core/gie/scoring.ts";
import type { EvidenceNode } from "../../../shared/geo-core/gie/types.ts";
import type { EvidenceType } from "../../../shared/geo-core/gie/types.ts";
import type { RawConclusion } from "../../../shared/geo-core/gie/contracts.ts";

// ── Fixtures ────────────────────────────────────────────────────────────────
const item = (weight: number, tier?: string): EvidenceItem => ({
  statement: `evidence w=${weight} tier=${tier ?? "none"}`,
  weight,
  tier,
});

const node = (id: string, evType: EvidenceType, tier: string, quality: number): EvidenceNode => ({
  id,
  source: "test",
  evType,
  statement: id,
  isObservation: true,
  tier,
  quality,
});

const conclusion = (supporting: string[], contradicting: string[] = []): RawConclusion => ({
  kind: "mineralization",
  statement: "test conclusion",
  statementSo: "gunaanad tijaabo",
  isInterpretation: false,
  supporting: supporting.map((evidenceId) => ({ evidenceId, contribution: 1 })),
  contradicting: contradicting.map((evidenceId) => ({ evidenceId, contribution: 1 })),
});

const byId = (...nodes: EvidenceNode[]) => new Map(nodes.map((n) => [n.id, n]));

// ── The core is reachable and executable from the app ───────────────────────
describe("shared core is usable from the mobile runtime", () => {
  test("resolves across the project boundary and exports live values", () => {
    // If Metro/jest could not resolve outside mobile/, this import would throw.
    expect(typeof computeConfidence).toBe("function");
    expect(typeof scoreConclusion).toBe("function");
    expect(TIER_WEIGHT.mapped).toBe(0.85);
  });
});

// ── GeoContext confidence — identical arithmetic to the server ──────────────
describe("computeConfidence", () => {
  test("no evidence scores zero and says so", () => {
    const c = computeConfidence([]);
    expect(c.score).toBe(0);
    expect(c.overall).toBe("Low");
    expect(c.factors).toContain("No supporting evidence at this location");
  });

  test("single mapped item: 0.8 × 0.85 = 0.68", () => {
    expect(computeConfidence([item(0.8, "mapped")]).score).toBe(0.68);
  });

  test("two independent items combine by noisy-OR, not by sum", () => {
    // effective: 0.8×0.85 = 0.68 ; 0.5×0.5 = 0.25
    // 1 − (1−0.68)(1−0.25) = 1 − 0.32×0.75 = 0.76
    const c = computeConfidence([item(0.8, "mapped"), item(0.5, "community")]);
    expect(c.score).toBe(0.76);
    expect(c.score).toBeLessThan(0.68 + 0.25); // corroboration, never addition
  });

  test("an unknown tier does not silently zero the item", () => {
    expect(computeConfidence([item(0.5, "not_a_real_tier")]).score).toBe(0.5);
  });

  test("band boundaries", () => {
    expect(bandFor(0.33)).toBe("Low");
    expect(bandFor(0.34)).toBe("Moderate");
    expect(bandFor(0.66)).toBe("Moderate");
    expect(bandFor(0.67)).toBe("High");
  });
});

// ── GIE scoring — the invariants that must survive the port ─────────────────
describe("scoreConclusion", () => {
  test("knowledge_kb is the weakest tier (EMIE: knowledge enriches, never inflates)", () => {
    expect(tierWeight("knowledge_kb")).toBe(0.35);
    expect(tierWeight("field_observation")).toBe(0.9);
    expect(tierWeight("ai_visual")).toBe(0.4);
    expect(tierWeight("knowledge_kb")).toBeLessThan(tierWeight("ai_visual"));
  });

  test("single evidence group is capped at 60 — one source is never near-certain", () => {
    // Four strong field observations, all the same evType.
    const nodes = byId(
      node("e1", "field", "field_observation", 1),
      node("e2", "field", "field_observation", 1),
      node("e3", "field", "field_observation", 1),
      node("e4", "field", "field_observation", 1),
    );
    const s = scoreConclusion(conclusion(["e1", "e2", "e3", "e4"]), nodes);
    // Uncapped noisy-OR of four 0.9 edges would be ~0.9999.
    expect(s.confidence).toBe(60);
  });

  test("knowledge alone cannot produce high confidence", () => {
    const nodes = byId(
      node("k1", "knowledge", "knowledge_kb", 1),
      node("k2", "knowledge", "knowledge_kb", 1),
      node("k3", "knowledge", "knowledge_kb", 1),
    );
    const s = scoreConclusion(conclusion(["k1", "k2", "k3"]), nodes);
    expect(s.confidence).toBeLessThanOrEqual(60);
  });

  test("independent groups corroborate past the single-group cap", () => {
    const nodes = byId(
      node("e1", "field", "field_observation", 1),
      node("e2", "spatial", "mapped", 1),
    );
    const s = scoreConclusion(conclusion(["e1", "e2"]), nodes);
    // 1 − (1−0.9)(1−0.85) = 0.985 → two groups, so the 0.6 cap does not apply.
    expect(s.confidence).toBeGreaterThan(60);
    expect(s.confidence).toBeCloseTo(98.5, 1);
  });

  test("contradicting evidence reduces, and cannot be ignored", () => {
    const nodes = byId(
      node("e1", "field", "field_observation", 1),
      node("e2", "spatial", "mapped", 1),
      node("x1", "visual", "ai_visual", 1),
    );
    const clean = scoreConclusion(conclusion(["e1", "e2"]), nodes).confidence;
    const disputed = scoreConclusion(conclusion(["e1", "e2"], ["x1"]), nodes).confidence;
    expect(disputed).toBeLessThan(clean);
  });

  test("links to evidence that does not exist are dropped, not counted", () => {
    const nodes = byId(node("e1", "field", "field_observation", 1));
    const s = scoreConclusion(conclusion(["e1", "ghost"]), nodes);
    expect(s.supportingWeights).toHaveLength(1);
  });

  test("edgeWeight = contribution × tier × quality, and a missing node is zero", () => {
    const n = node("e1", "field", "field_observation", 0.5);
    expect(edgeWeight({ evidenceId: "e1", contribution: 0.8 }, n)).toBeCloseTo(0.8 * 0.9 * 0.5, 10);
    expect(edgeWeight({ evidenceId: "e1", contribution: 1 }, undefined)).toBe(0);
  });
});
