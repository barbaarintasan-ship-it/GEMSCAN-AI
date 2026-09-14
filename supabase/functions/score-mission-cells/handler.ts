// score-mission-cells Edge Function — Phase 3 (Solo→Team shared-targeting).
//
// STEP B/C of the pipeline generate-mission-cells (STEP A, geometry) already
// established:
//   exploration_area boundary -> polygonToCells -> H3 cells (STEP A, unchanged)
//   H3 cells -> shared TargetingEngine.targetAt() -> prospectivity_score (STEP B)
//   score persisted via enterprise.score_mission_cells (STEP C)
// Ranking/display (STEP D) is a plain sort over the stored scores — done
// client-side in the manager UI, not here.
//
// SERVER-AUTHORITATIVE, same shape as accept-recommended-area: this function
// derives each cell's centre from H3 geometry alone and re-scores it via the
// SAME shared TargetingEngine.targetAt() Phase 1 built — never a client
// score, never a second scoring algorithm.
//
// BATCH, NOT PER-CELL: one GeoContextBatchSource/TargetingEngine is
// constructed ONCE for the whole request (see makeServerGeoContext's own
// header note — the engine/gateway/providers it builds are already reused
// across calls to targetAt() on the same instance); only the underlying
// per-cell geo queries repeat, which is unavoidable work, not overhead.
//
// By default only UNSCORED cells (prospectivity_score is null) are scored —
// safe to call repeatedly (e.g. right after generate-mission-cells) without
// re-doing work. `force: true` re-scores every cell in the mission/area,
// which is deliberately still available (Phase 8 will need a re-score path;
// this function's shape already supports it) without being the default.
//
// NOT an AI call. Deterministic geological intelligence only.
import { corsHeaders } from "../_shared/cors.ts";
import { BadRequestError, errorResponse, json } from "../_shared/enterprise/errors.ts";
import { resolveActor as realResolveActor, type Actor } from "../_shared/enterprise/auth.ts";
import { serviceClient, userClient, type DbClient } from "../_shared/enterprise/clients.ts";
import { makeServerGeoContext, TEAM_TARGETING_ENGINE_VERSION } from "../_shared/geocontext/serverGeoContext.ts";
import { cellFor, cellCentre, kRing } from "../_shared/geocontext/h3.ts";
import { TargetingEngine, type H3Ops } from "../../../shared/geo-core/gie/targetingEngine.ts";
import { teamIntegratedScore, type TeamStructuredEvidenceRow } from "../_shared/gie/teamIntegratedEvidence.ts";

const H3_OPS: H3Ops = { cellFor, cellCentre, kRing };

/**
 * Hard cap on how many cells one invocation scores.
 *
 * DOCUMENTED SCALING LIMIT, not an architecture. The Phase 2 default
 * envelope is 7 cells; a large manually-drawn area could carry hundreds. At
 * this size a synchronous Edge Function call (a few seconds per cell, most
 * of it network round-trips to the geo schema's RPCs) is still the right
 * tool — this cap exists so a very large area fails loudly with a clear
 * message rather than timing out silently. If Team missions routinely need
 * areas larger than this, that is a real future scaling step (a background
 * job/queue), not something to build speculatively now.
 */
export const MAX_CELLS_PER_SCORING_CALL = 200;

export interface ScoredCell {
  targetH3: string;
  score: number;
  /** Phase 8 — baseline + structured evidence, via the same noisy-OR arithmetic
   *  Solo's own Integrated Prospectivity Score uses. Null when the cell has no
   *  structured evidence yet — never a value indistinguishable from "checked,
   *  found nothing new". */
  integratedScore: number | null;
  evidenceSampleCount: number;
}

export interface ScoreMissionCellsResponse {
  missionId: string;
  requested: number;
  scored: number;
  persisted: number;
  cells: ScoredCell[];
  evidenceCaveat: string;
}

export interface CellToScore {
  targetH3: string;
  lat: number;
  lng: number;
}

export interface ScoreMissionCellsDeps {
  resolveActor: (req: Request) => Promise<Actor>;
  userClient: (req: Request) => DbClient;
  /** Which cells need scoring — a plain read, RLS-visible to any project member (same as area_boundary_geojson, 0116's own comment: reads are harmless, the mutation is what's gated). */
  cellsToScore: (req: Request, missionId: string, areaId: string | null, force: boolean) => Promise<CellToScore[]>;
  /** Re-scores a batch of cells fresh — server-authoritative, never client-trusted. */
  scoreCells: (missionId: string, cells: CellToScore[], commodity: string | null) => Promise<ScoredCell[]>;
}

const EVIDENCE_CAVEAT =
  "Structural (fault/contact), lithology-prior and terrain-prior evidence are " +
  "not yet available server-side (they need a live equivalent of the mobile " +
  "bundled pack, not built yet). Occurrence, association, community and " +
  "geology-unit evidence are included in these scores.";

async function defaultCellsToScore(
  req: Request, missionId: string, areaId: string | null, force: boolean,
): Promise<CellToScore[]> {
  // Phase 4: a cell may now have MULTIPLE rows (one canonical, contributor_id
  // IS NULL, plus one per assigned contributor — see 0125/0126). Scoring only
  // ever reads/writes the canonical row: contributor rows carry no score of
  // their own (score_mission_cells's RPC only ever updates
  // contributor_id IS NULL rows too), so this filter must be here or a
  // multi-contributor cell would be enumerated once per contributor and
  // re-scored redundantly.
  const client = userClient(req).schema("enterprise");
  let query = client
    .from("mission_assignment")
    .select("target_h3, prospectivity_score")
    .eq("mission_id", missionId)
    .is("contributor_id", null);
  if (areaId) query = query.eq("area_id", areaId);
  if (!force) query = query.is("prospectivity_score", null);

  const { data, error } = await query;
  if (error) throw new BadRequestError(error.message);
  return (data ?? []).map((row: { target_h3: string }) => {
    const c = cellCentre(row.target_h3);
    return { targetH3: row.target_h3, lat: c.lat, lng: c.lng };
  });
}

/**
 * Every structured-evidence row for the mission, grouped by which cell
 * (assignment_h3, 0127) its sample landed in. Prefetched ONCE per scoring
 * call — never per-cell — same batching principle as the shared
 * GeoContextBatchSource this function already reuses across cells.
 */
async function evidenceByCell(missionId: string): Promise<Map<string, TeamStructuredEvidenceRow[]>> {
  const svc = serviceClient();
  const { data, error } = await svc
    .from("sample")
    .select("id,assignment_h3,sample_structured_evidence(evidence_type,payload,verification_status)")
    .eq("mission_id", missionId)
    .not("assignment_h3", "is", null)
    .is("deleted_at", null);
  if (error) throw new Error(`evidenceByCell: ${error.message}`);

  const byCell = new Map<string, TeamStructuredEvidenceRow[]>();
  for (const sample of (data ?? []) as Array<{
    id: string; assignment_h3: string;
    sample_structured_evidence: Array<{ evidence_type: string; payload: Record<string, unknown>; verification_status: string }>;
  }>) {
    const rows = (sample.sample_structured_evidence ?? []).map((e) => ({
      sampleId: sample.id,
      evidenceType: e.evidence_type as TeamStructuredEvidenceRow["evidenceType"],
      payload: e.payload ?? {},
      verificationStatus: e.verification_status as TeamStructuredEvidenceRow["verificationStatus"],
    }));
    if (rows.length === 0) continue;
    const existing = byCell.get(sample.assignment_h3) ?? [];
    existing.push(...rows);
    byCell.set(sample.assignment_h3, existing);
  }
  return byCell;
}

async function defaultScoreCells(missionId: string, cells: CellToScore[], commodity: string | null): Promise<ScoredCell[]> {
  const geo = makeServerGeoContext(serviceClient());
  const engine = new TargetingEngine(geo, H3_OPS);
  const evidence = await evidenceByCell(missionId);
  const out: ScoredCell[] = [];
  for (const cell of cells) {
    const centre = { lat: cell.lat, lng: cell.lng };
    const target = await engine.targetAt(centre, centre, { commodity });
    // Invariant 2: a cell with nothing to say about itself is not scored —
    // it stays null (not zero, which would read as "known to be barren").
    if (!target) continue;
    const cellEvidence = evidence.get(cell.targetH3) ?? [];
    out.push({
      targetH3: cell.targetH3,
      score: target.score,
      // Phase 8: baseline evidence the engine ALREADY computed (target.evidence),
      // never recomputed — combined with structured evidence for a SEPARATE
      // informational number. See teamIntegratedEvidence.ts's own header note
      // for why this never feeds back into `target.score` itself.
      integratedScore: teamIntegratedScore(target.evidence, cellEvidence),
      evidenceSampleCount: new Set(cellEvidence.map((r) => r.sampleId)).size,
    });
  }
  return out;
}

export const defaultDeps: ScoreMissionCellsDeps = {
  resolveActor: realResolveActor,
  userClient: (req) => userClient(req),
  cellsToScore: defaultCellsToScore,
  scoreCells: defaultScoreCells,
};

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

export async function handleScoreMissionCells(
  req: Request,
  deps: ScoreMissionCellsDeps = defaultDeps,
): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    await deps.resolveActor(req); // verifies the JWT; score_mission_cells re-derives auth.uid() from the forwarded token, exactly like generate-mission-cells.

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const missionId = str(body.missionId);
    const areaId = str(body.areaId);
    const commodity = str(body.commodity);
    const force = body.force === true;

    if (!missionId) throw new BadRequestError("missionId is required");

    const cells = await deps.cellsToScore(req, missionId, areaId, force);
    if (cells.length === 0) {
      const response: ScoreMissionCellsResponse = {
        missionId, requested: 0, scored: 0, persisted: 0, cells: [], evidenceCaveat: EVIDENCE_CAVEAT,
      };
      return json(response);
    }
    if (cells.length > MAX_CELLS_PER_SCORING_CALL) {
      throw new BadRequestError(
        `this request would score ${cells.length} cells, above the current limit of ${MAX_CELLS_PER_SCORING_CALL} per call — ` +
        `score by area (areaId) or in smaller batches`,
      );
    }

    const scored = await deps.scoreCells(missionId, cells, commodity);

    let persisted = 0;
    if (scored.length > 0) {
      const client = deps.userClient(req);
      const { data, error } = await client.schema("enterprise").rpc("score_mission_cells", {
        p_mission: missionId,
        p_scores: scored.map((s) => ({
          target_h3: s.targetH3, score: s.score, engine_version: TEAM_TARGETING_ENGINE_VERSION,
          integrated_score: s.integratedScore, evidence_sample_count: s.evidenceSampleCount,
        })),
      });
      if (error) throw new BadRequestError(error.message);
      persisted = (data as number) ?? 0;
    }

    const response: ScoreMissionCellsResponse = {
      missionId, requested: cells.length, scored: scored.length, persisted, cells: scored,
      evidenceCaveat: EVIDENCE_CAVEAT,
    };
    return json(response);
  } catch (err) {
    return errorResponse(err);
  }
}
