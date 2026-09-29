// Phase 18 (Geological Intelligence Transformation) — the end-to-end
// acceptance test named in the audit as item #30, still unaddressed as of
// Phase 17: every function in the chain has strong isolated/mocked-dependency
// coverage, but nothing had ever proven the pieces connect.
//
//   discover-region-targets -> score-mission-cells -> review-area
//     -> compare-areas -> area-geological-analogues -> target-report
//     -> find-gold (mobile's plain-language consumption of the same shape)
//
// WHAT IS FAKED, AND WHY: only the true I/O boundaries — auth (resolveActor)
// and the database (userClient's .rpc(...) calls). Every scoring/evidence
// number in this file comes from the REAL, unmodified TargetingEngine
// (shared/geo-core/gie/targetingEngine.ts) reading a REAL PackData built by
// the REAL packWithMapFeatures() — no new scoring formula, no shortcuts. The
// four downstream functions (review-area/compare-areas/analogues/
// target-report) are, in production, thin pass-throughs to a single Postgres
// RPC each (see their own handler.ts header comments) — this test proves
// THEIR OWN plumbing doesn't drop or rename a field between the request and
// the RPC, and between the RPC and the response. It intentionally does NOT
// re-implement compare_mission_areas/area_geological_analogues/
// get_target_report's own SQL logic (that's this repo's job in migration
// tests and the live-verification already done this session, not a fake's
// job) — the fake RPCs for those three simply read back exactly what
// score-mission-cells and review-area wrote into `store` below, which is
// precisely the "did it survive the pipeline unmodified" question this test
// exists to answer.
//
// A REAL, IN-PROCESS mission_assignment/exploration_area STAND-IN: `store`
// is a plain in-memory map, not a second implementation of either table's
// business rules — it only ever receives values the real handlers under
// test compute and hands them back verbatim to the next real handler in the
// chain, exactly what a real Postgres row would do.
import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { handleDiscoverRegionTargets, type RegionDiscoveryDeps } from "../discover-region-targets/handler.ts";
import { handleScoreMissionCells, type ScoreMissionCellsDeps, type ScoredCell } from "../score-mission-cells/handler.ts";
import { handleReviewArea, type ReviewAreaDeps } from "../review-area/handler.ts";
import { handleCompareAreas, type CompareAreasDeps } from "../compare-areas/handler.ts";
import { handleAreaGeologicalAnalogues, type AreaAnaloguesDeps } from "../area-geological-analogues/handler.ts";
import { handleTargetReport, type TargetReportDeps } from "../target-report/handler.ts";
import type { Actor } from "./enterprise/auth.ts";
import { cellFor, cellCentre } from "./geocontext/h3.ts";
import { fillMultiPolygon } from "../generate-mission-cells/h3fill.ts";
import { packWithMapFeatures } from "./geocontext/structuralPack.ts";
import { TargetingEngine, type H3Ops, type GeoContextBatchSource } from "../../../shared/geo-core/gie/targetingEngine.ts";
import { bandFor } from "../../../shared/geo-core/confidence.ts";
import type { GeoContext } from "../../../shared/geo-core/types.ts";
import type { PackCommodityProfile, PackMapFeature } from "../../../shared/geo-core/pack/types.ts";
// mobile/lib/enterprise/plainLanguage.ts (find-gold's own plain-language
// layer) is NOT imported here: its sibling module `./missions` has an
// extensionless import Deno's type-checker can't resolve (fine under
// Metro/tsc, not under `deno test`). Its real behaviour against exactly
// this report shape (score/reasons) is unit-tested for real in Part B
// (mobile/app/(app)/enterprise/find-gold*/__tests__), which is the correct
// runtime for it — this link is closed jointly by this file asserting the
// SHAPE find-gold consumes, and Part B asserting find-gold's OWN translation
// of that shape.

const OWNER: Actor = { userId: "owner-1", email: "owner@example.com", contributorId: "c1", role: "admin" };
const MISSION_ID = "mission-chain-1";
const AREA_A = "area-a-hot"; // the region-wide-discovered, gold/placer/drainage target
const AREA_B = "area-b-cold"; // an existing area in the same mission, scored via a plain occurrence

function req(body?: Record<string, unknown>, method = "POST"): Request {
  return new Request("https://x/chain", { method, body: body ? JSON.stringify(body) : undefined });
}

// ── Real evidence fixtures (same shapes proven in team-targeting's and
// discover-region-targets' own commodity-fix tests) ─────────────────────────
const RES = 7;
const SMALL_BOX: number[][] = [[45.00, 2.00], [45.02, 2.00], [45.02, 2.02], [45.00, 2.02], [45.00, 2.00]];
const SMALL_POLYGON = { type: "Polygon", coordinates: [SMALL_BOX] };
const HOT_CELL = fillMultiPolygon({ type: "MultiPolygon", coordinates: [[SMALL_BOX]] }, RES)[0];
const COLD_CELL = cellFor(2.5, 45.5); // a distinct, unrelated cell standing in for "an area already in the mission"

const REAL_H3_OPS: H3Ops = { cellFor, cellCentre, kRing: () => { throw new Error("kRing must not be called by this chain"); } };

const GOLD_PLACER_PROFILE: PackCommodityProfile = {
  code: "gold", name: "Gold", category: "metal",
  typical_host_rocks: null, associated_minerals: null, alteration_styles: null,
  deposit_models: ["placer / alluvial"], tectonic_settings: null,
  exploration_indicators: null, industrial_uses: null,
  is_critical_mineral: null, strategic_importance: null, confidence_limitations: "",
};

function drainageFeatureAt(cell: string): PackMapFeature {
  const c = cellCentre(cell);
  return {
    id: "drainage-1", kind: "drainage", name: null, source: "test", attributes: null,
    lines: [[[c.lng - 0.01, c.lat], [c.lng + 0.01, c.lat]]],
    bbox: [c.lng - 0.01, c.lat, c.lng + 0.01, c.lat],
  };
}

function emptyContext(lat: number, lng: number): GeoContext {
  return {
    location: { lat, lng },
    geology: {}, formations: [], lithology: [], hostRocks: [], faults: [], intrusions: [],
    metamorphism: {}, knownOccurrences: [], commodityAssociations: [],
    geochemistry: { anomalies: [] }, geophysics: { anomalies: [] }, remoteSensing: { alteration: [] },
    historicalReports: [], communityEvidence: {},
    reasoningFactors: [], evidence: { providers: [], datasets: [] },
    confidence: { overall: "Low", score: 0, byProvider: {}, factors: [] },
    meta: { engineVersion: "test", generatedAt: "2026-01-01T00:00:00.000Z", providersRun: [], providersFailed: [], cache: "miss" },
  };
}

/** HOT_CELL: no occurrence, relies entirely on the drainage+gold pack conditioning.
 *  COLD_CELL: a plain occurrence, no pack conditioning needed — a deliberately
 *  different evidence path so compare-areas is diffing two genuinely different
 *  bases for a score, not two copies of the same fixture. */
function chainGeoSource(): GeoContextBatchSource {
  const cold = cellCentre(COLD_CELL);
  const query = async (lat: number, lng: number) => {
    const ctx = emptyContext(lat, lng);
    if (Math.abs(lat - cold.lat) < 0.001 && Math.abs(lng - cold.lng) < 0.001) {
      ctx.knownOccurrences = [{ commodity: "Gold", distanceM: 300 }];
    }
    return { context: ctx, hasKnowledge: true };
  };
  return { contextAt: query, openBatch: async () => query };
}

function buildRealEngine(commodity: string | null): TargetingEngine {
  return new TargetingEngine(
    chainGeoSource(), REAL_H3_OPS, undefined,
    () => packWithMapFeatures([drainageFeatureAt(HOT_CELL)], commodity ? [GOLD_PLACER_PROFILE] : []),
  );
}

// ── The in-memory stand-in for what Postgres would actually persist ────────
interface StoredScore {
  score: number; integratedScore: number | null; reasons: unknown; coverage: unknown; evidence: unknown;
}
interface StoredArea {
  targetH3: string; commodity: string | null;
  reviewStatus?: string; reviewedBy?: string; reviewedAt?: string; notes?: string | null;
}
const store = {
  scores: new Map<string, StoredScore>(), // key: target_h3
  areas: new Map<string, StoredArea>([
    [AREA_A, { targetH3: HOT_CELL, commodity: "gold" }],
    [AREA_B, { targetH3: COLD_CELL, commodity: "gold" }],
  ]),
};

function fakeUserClient(onRpc?: (fn: string, args: Record<string, unknown>) => void) {
  return (_req: Request) => ({
    schema: (_s: string) => ({
      rpc: (fn: string, args: Record<string, unknown>) => {
        onRpc?.(fn, args);
        if (fn === "score_mission_cells") {
          const rows = args.p_scores as Array<{ target_h3: string; score: number; integrated_score: number | null; reasons: unknown; coverage: unknown; evidence: unknown }>;
          for (const r of rows) {
            store.scores.set(r.target_h3, { score: r.score, integratedScore: r.integrated_score, reasons: r.reasons, coverage: r.coverage, evidence: r.evidence });
          }
          return Promise.resolve({ data: rows.length, error: null });
        }
        if (fn === "review_area") {
          const area = store.areas.get(args.p_area as string);
          assert(area, `review_area called for an unknown area: ${args.p_area}`);
          area!.reviewStatus = args.p_decision as string;
          area!.reviewedBy = "server-derived-uid";
          area!.reviewedAt = "2026-09-25T00:00:00Z";
          area!.notes = (args.p_notes as string | null) ?? null;
          return Promise.resolve({
            data: { area_id: args.p_area, review_status: args.p_decision, reviewed_by: area!.reviewedBy, reviewed_at: area!.reviewedAt },
            error: null,
          });
        }
        if (fn === "compare_mission_areas") {
          const read = (areaId: string) => {
            const area = store.areas.get(areaId)!;
            const scored = store.scores.get(area.targetH3)!;
            return { areaId, score: scored.score, reasons: scored.reasons, coverage: scored.coverage, commodity: area.commodity };
          };
          return Promise.resolve({ data: { a: read(args.p_area_a as string), b: read(args.p_area_b as string) }, error: null });
        }
        if (fn === "area_geological_analogues") {
          const area = store.areas.get(args.p_area as string)!;
          return Promise.resolve({
            data: { areaId: args.p_area, commodity: area.commodity, analogues: [] as unknown[] },
            error: null,
          });
        }
        if (fn === "get_target_report") {
          const area = store.areas.get(args.p_area as string)!;
          const scored = store.scores.get(area.targetH3)!;
          return Promise.resolve({
            data: {
              areaId: args.p_area, missionId: args.p_mission, commodity: area.commodity,
              score: scored.score, integratedScore: scored.integratedScore,
              reasons: scored.reasons, coverage: scored.coverage, evidence: scored.evidence,
              reviewStatus: area.reviewStatus ?? "pending",
            },
            error: null,
          });
        }
        throw new Error(`fakeUserClient: unexpected RPC "${fn}"`);
      },
    }),
  }) as any;
}

Deno.test("[Phase 18 acceptance chain] discover-region-targets -> score-mission-cells -> review-area -> compare-areas -> area-geological-analogues -> target-report -> find-gold, no drift", async () => {
  // ── Link 1: discover-region-targets finds AREA_A's cell for real, using the
  // real TargetingEngine + real gold/placer/drainage conditioning ───────────
  const discoverDeps: RegionDiscoveryDeps = {
    resolveActor: async () => OWNER,
    isMissionManager: async () => true,
    buildEngine: async (_lat, _lng, _radiusM, commodity) => buildRealEngine(commodity),
  };
  const discoverRes = await handleDiscoverRegionTargets(
    req({ missionId: MISSION_ID, polygon: SMALL_POLYGON, minScore: 0, commodity: "gold" }), discoverDeps,
  );
  assertEquals(discoverRes.status, 200);
  const discoverBody = await discoverRes.json();
  const hotCluster = discoverBody.clusters.find((c: any) => c.memberCells.includes(HOT_CELL));
  assert(hotCluster, "discover-region-targets must surface the drainage-conditioned cell as a real target");
  assert(hotCluster.score > 0);
  assertEquals(hotCluster.scoredForCommodity, "gold");
  const discoveredScore = hotCluster.score;
  const discoveredReasons = hotCluster.reasons;

  // ── Link 2: score-mission-cells independently re-scores BOTH the newly
  // discovered cell (AREA_A) and an existing mission cell (AREA_B), via the
  // SAME real engine machinery, and persists both — proving discovery-time
  // and assignment-time scoring agree for identical evidence, and that the
  // handler's own RPC-argument shaping doesn't drop a field ──────────────
  let scoreRpcArgs: Record<string, unknown> | null = null;
  const scoreDeps: ScoreMissionCellsDeps = {
    resolveActor: async () => OWNER,
    userClient: fakeUserClient((fn, args) => { if (fn === "score_mission_cells") scoreRpcArgs = args; }),
    cellsToScore: async () => {
      const hot = cellCentre(HOT_CELL); const cold = cellCentre(COLD_CELL);
      return [{ targetH3: HOT_CELL, lat: hot.lat, lng: hot.lng }, { targetH3: COLD_CELL, lat: cold.lat, lng: cold.lng }];
    },
    scoreCells: async (_missionId, cells, commodity) => {
      const engine = buildRealEngine(commodity);
      const out: ScoredCell[] = [];
      for (const c of cells) {
        const centre = { lat: c.lat, lng: c.lng };
        const t = await engine.targetAt(centre, centre, { commodity });
        assert(t, `expected real evidence at ${c.targetH3}`);
        out.push({ targetH3: c.targetH3, score: t!.score, integratedScore: null, evidenceSampleCount: 0, reasons: t!.reasons, coverage: t!.coverage, evidence: t!.evidence });
      }
      return out;
    },
  };
  const scoreRes = await handleScoreMissionCells(req({ missionId: MISSION_ID, commodity: "gold" }), scoreDeps);
  assertEquals(scoreRes.status, 200);
  const scoreBody = await scoreRes.json();
  const hotScored = scoreBody.cells.find((c: any) => c.targetH3 === HOT_CELL);
  const coldScored = scoreBody.cells.find((c: any) => c.targetH3 === COLD_CELL);
  assert(hotScored && coldScored, "both cells must score (real evidence exists for each)");
  assert(hotScored.score > 0);
  assert(coldScored.score > 0);
  // Discovery-time and assignment-time scoring must agree for identical evidence.
  assertEquals(hotScored.score, discoveredScore);
  assertEquals(hotScored.reasons, discoveredReasons);
  // The RPC must have received exactly what the handler's response reports — no silent renaming/dropping.
  assert(scoreRpcArgs, "score_mission_cells RPC must have been called");
  const sentRows = (scoreRpcArgs as any).p_scores as any[];
  const sentHot = sentRows.find((r) => r.target_h3 === HOT_CELL);
  assertEquals(sentHot.score, hotScored.score);
  assertEquals(sentHot.reasons, hotScored.reasons);
  assertEquals(sentHot.coverage, hotScored.coverage);
  assertEquals(sentHot.evidence, hotScored.evidence);
  // What's now "persisted" (store) must be exactly what was scored, for both areas.
  assertEquals(store.scores.get(HOT_CELL)?.score, hotScored.score);
  assertEquals(store.scores.get(COLD_CELL)?.score, coldScored.score);

  // ── Link 3: review-area marks AREA_A accepted — must not touch score ────
  const reviewDeps: ReviewAreaDeps = { resolveActor: async () => OWNER, userClient: fakeUserClient() };
  const reviewRes = await handleReviewArea(req({ missionId: MISSION_ID, areaId: AREA_A, decision: "accepted", notes: "quartz veins observed" }), reviewDeps);
  assertEquals(reviewRes.status, 200);
  const reviewBody = await reviewRes.json();
  assertEquals(reviewBody.reviewStatus, "accepted");
  assertEquals(store.areas.get(AREA_A)?.reviewStatus, "accepted");
  assertEquals(store.scores.get(HOT_CELL)?.score, hotScored.score, "review must never mutate the persisted score");

  // ── Link 4: compare-areas(A, B) must return exactly what was persisted for
  // each side, unmodified ─────────────────────────────────────────────────
  const compareDeps: CompareAreasDeps = { resolveActor: async () => OWNER, userClient: fakeUserClient() };
  const compareRes = await handleCompareAreas(req({ missionId: MISSION_ID, areaIdA: AREA_A, areaIdB: AREA_B }), compareDeps);
  assertEquals(compareRes.status, 200);
  const compareBody = await compareRes.json();
  assertEquals(compareBody.a.score, hotScored.score);
  assertEquals(compareBody.a.reasons, hotScored.reasons);
  assertEquals(compareBody.a.commodity, "gold");
  assertEquals(compareBody.b.score, coldScored.score);
  assertEquals(compareBody.b.reasons, coldScored.reasons);

  // ── Link 5: area-geological-analogues(A) must carry the same commodity
  // context forward ───────────────────────────────────────────────────────
  const analoguesDeps: AreaAnaloguesDeps = { resolveActor: async () => OWNER, userClient: fakeUserClient() };
  const analoguesRes = await handleAreaGeologicalAnalogues(req({ missionId: MISSION_ID, areaId: AREA_A }), analoguesDeps);
  assertEquals(analoguesRes.status, 200);
  const analoguesBody = await analoguesRes.json();
  assertEquals(analoguesBody.commodity, "gold");

  // ── Link 6: target-report(A) must assemble score/reasons/evidence/coverage/
  // commodity/review-status with zero drift from what every earlier link
  // produced ───────────────────────────────────────────────────────────────
  const reportDeps: TargetReportDeps = { resolveActor: async () => OWNER, userClient: fakeUserClient() };
  const reportRes = await handleTargetReport(req({ missionId: MISSION_ID, areaId: AREA_A }), reportDeps);
  assertEquals(reportRes.status, 200);
  const report = await reportRes.json();
  assertEquals(report.score, discoveredScore, "target-report's score must trace all the way back to discovery");
  assertEquals(report.score, hotScored.score);
  assertEquals(report.reasons, discoveredReasons);
  assertEquals(report.coverage, hotScored.coverage);
  assertEquals(report.evidence, hotScored.evidence);
  assertEquals(report.commodity, "gold");
  assertEquals(report.reviewStatus, "accepted");

  // ── Link 7: find-gold. bandFor() is the SAME shared function find-gold's
  // screens call (via plainLanguage.ts's bandToSimpleLevel(bandFor(score)));
  // this asserts the exact shape find-gold receives is complete and
  // translatable. find-gold's own translation of it is unit-tested for real
  // against fixtures of this shape in Part B (mobile find-gold* tests) —
  // see the import-boundary note above for why that runs there, not here.
  const band = bandFor(report.score);
  assert(band === "High" || band === "Moderate" || band === "Low", `unexpected band for score ${report.score}`);
  assert(Array.isArray(report.reasons) && report.reasons.length > 0, "find-gold needs at least one reason to say something plain");
  assert(report.reasons.every((r: any) => typeof r?.kind === "string"), "every reason must carry a translatable kind");
});
