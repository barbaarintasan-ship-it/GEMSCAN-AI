// Team Mission Mode — client wrapper over the mission/H3-assignment RPCs
// built server-side (Phase 2A/2B/2C). Same shape as lib/enterprise/team.ts:
// deliberately dumb, authorization lives entirely in the RPCs/RLS.
import { supabase } from "../supabase";
import { getAuthUserTimed } from "../getAuthUserTimed";

const FUNCTIONS_URL = process.env.EXPO_PUBLIC_SUPABASE_FUNCTIONS_URL!;

export type MissionStatus = "planned" | "active" | "paused" | "completed" | "archived";
export type ContributorRole =
  | "normal" | "field_contributor" | "team_leader" | "geologist"
  | "senior_geologist" | "chief_geologist" | "company_manager" | "admin";
export type AssignmentStatus = "assigned" | "in_progress" | "completed" | "skipped" | "expired";

export type Mission = {
  id: string;
  name: string;
  description: string | null;
  status: MissionStatus;
  project_id: string;
  owner_id: string;
};

export type MyMission = { mission_id: string; role: ContributorRole; mission: Mission };

export type Assignment = {
  id: string;
  target_h3: string;
  contributor_id: string | null;
  status: AssignmentStatus;
  due_at: string | null;
  area_id: string | null;
  created_at: string;
  /**
   * Phase 3 (Solo→Team shared-targeting) — deterministic prospectivity score
   * (0..1, NOT a probability) for this exact cell, from the SAME shared
   * TargetingEngine Solo Exploration uses. Null = not yet scored — a real
   * state, not zero. Independent of contributor_id: a cell can be ranked
   * with nobody assigned yet (cell INTELLIGENCE vs cell ASSIGNMENT are
   * different concepts sharing one row).
   */
  prospectivity_score: number | null;
  scored_at: string | null;
  /**
   * Phase 8 — prospectivity_score combined with any structured evidence
   * (assay/geophysics/mapping/field observation) contributors have collected
   * in this cell, via the SAME noisy-OR arithmetic Solo's own Integrated
   * Prospectivity Score uses. Null until evidence exists — a real state
   * ("nothing collected yet"), not zero and not equal to prospectivity_score.
   * prospectivity_score itself is never touched by evidence — see
   * teamIntegratedEvidence.ts's own header note.
   */
  integrated_score: number | null;
  evidence_sample_count: number | null;
};

export type MissionContributor = {
  contributor_id: string;
  email: string;
  role: ContributorRole;
  added_at: string;
};

export type MissionArea = { area_id: string; name: string };

export type MyProject = { id: string; name: string; organization_id: string | null; owner_id: string | null };

/**
 * Phase 2D — mission-level only. `observation_count` counts rows across the
 * four structured-observation tables (rock/mineral/alteration/structural),
 * NOT samples — the same meaning `submit_sample`'s own `observation_count`
 * return value has carried since its first version. `coverage_pct` is
 * always 0: `mission_assignment.target_h3` (H3 res 7) and
 * `sample_location.h3_cell` (res 9) are different resolutions with no
 * persisted mapping between them, so a percentage here would be invented,
 * not measured. Deferred until assignment-cell provenance is persisted.
 */
export type MissionProgress = {
  mission_id: string;
  observation_count: number;
  sample_count: number;
  coverage_pct: number;
  updated_at: string;
};

/** Missions the caller is a contributor (or owner) on. */
export async function fetchMyMissions(): Promise<MyMission[]> {
  const user = await getAuthUserTimed();
  const uid = user?.id;
  if (!uid) return [];
  const { data, error } = await supabase.schema("enterprise")
    .from("mission_contributor")
    .select("role, mission_id, exploration_mission(id,name,description,status,project_id,owner_id)")
    .eq("contributor_id", uid);
  if (error) throw error;
  return (data ?? [])
    .filter((r: any) => r.exploration_mission)
    .map((r: any) => ({ mission_id: r.mission_id, role: r.role, mission: r.exploration_mission as Mission }));
}

/**
 * Every mission_assignment ROW for a mission — as of Phase 4 this is NOT
 * one row per cell any more. Each cell has exactly one CANONICAL row
 * (`contributor_id === null`, carrying `prospectivity_score`/`scored_at`/
 * `area_id`) plus zero or more CONTRIBUTOR rows (`contributor_id` set, one
 * per assigned person). Use `groupMissionCells()` below to turn this flat
 * list back into "one card per cell" for display — do not render this array
 * directly as a cell list, or the same H3 cell will appear once per
 * contributor.
 */
export async function fetchMissionAssignments(missionId: string): Promise<Assignment[]> {
  const { data, error } = await supabase.schema("enterprise")
    .from("mission_assignment")
    .select("id,target_h3,contributor_id,status,due_at,area_id,created_at,prospectivity_score,scored_at,integrated_score,evidence_sample_count")
    .eq("mission_id", missionId)
    .order("target_h3");
  if (error) throw error;
  return data ?? [];
}

export type MissionCellGroup = {
  targetH3: string;
  /** The canonical row's own id — pass to nothing; it is never assigned or unassigned directly. */
  cellId: string;
  areaId: string | null;
  /** From the canonical row only. Null = not yet scored (a real state, not zero). */
  prospectivityScore: number | null;
  scoredAt: string | null;
  /** Phase 8 — see Assignment.integrated_score's own doc. */
  integratedScore: number | null;
  evidenceSampleCount: number;
  /** Every contributor currently holding this cell, empty when unassigned — the cell itself still exists either way. */
  contributors: Assignment[];
};

// Re-exported from its own dependency-free module (missionCellGrouping.ts)
// so the pure grouping/ranking logic is directly unit-testable without
// pulling in ../supabase's env-var guard — see that file's own header note.
export { groupMissionCells } from "./missionCellGrouping";

export async function fetchMissionContributors(missionId: string): Promise<MissionContributor[]> {
  const { data, error } = await supabase.schema("enterprise")
    .rpc("list_mission_contributors", { p_mission: missionId });
  if (error) throw error;
  return (data ?? []) as MissionContributor[];
}

export async function fetchMissionAreas(missionId: string): Promise<MissionArea[]> {
  const { data, error } = await supabase.schema("enterprise")
    .from("mission_area")
    .select("area_id, exploration_area(id,name)")
    .eq("mission_id", missionId);
  if (error) throw error;
  return (data ?? [])
    .filter((r: any) => r.exploration_area)
    .map((r: any) => ({ area_id: r.area_id, name: r.exploration_area.name as string }));
}

/** Projects the caller's orgs can see — create_mission is the real gate on which ones they can actually use. */
export async function fetchMyProjects(): Promise<MyProject[]> {
  const { data, error } = await supabase.schema("enterprise")
    .from("project")
    .select("id,name,organization_id,owner_id")
    .order("name");
  if (error) throw error;
  return data ?? [];
}

/** Direct insert — enterprise.project already grants this to authenticated,
 *  RLS requires org owner/admin (or personal ownership) at write time. */
export async function createProject(name: string, organizationId: string | null): Promise<MyProject> {
  const user = await getAuthUserTimed();
  const uid = user?.id;
  if (!uid) throw new Error("You must be signed in.");
  const { data, error } = await supabase.schema("enterprise")
    .from("project")
    .insert({ name: name.trim(), organization_id: organizationId, owner_id: uid, created_by: uid })
    .select("id,name,organization_id,owner_id")
    .single();
  if (error) throw error;
  return data as MyProject;
}

export async function createMission(projectId: string, name: string, description?: string): Promise<string> {
  const { data, error } = await supabase.schema("enterprise").rpc("create_mission", {
    p_project_id: projectId,
    p_name: name.trim(),
    p_description: description?.trim() || null,
  });
  if (error) throw error;
  return data as string;
}

export async function addMissionContributor(
  missionId: string,
  email: string,
  role: ContributorRole = "field_contributor",
): Promise<void> {
  const { error } = await supabase.schema("enterprise").rpc("add_mission_contributor", {
    p_mission: missionId,
    p_email: email.trim(),
    p_role: role,
  });
  if (error) throw error;
}

/**
 * Phase 4 (Solo→Team shared-targeting) — ADDITIVE, never destructive.
 * Assigning contributor B to a cell A already holds does not remove A; both
 * end up assigned. Calling this again for the SAME (cell, contributor) pair
 * is idempotent (updates due_at/status only, never creates a duplicate row).
 * `reassign` is kept for signature compatibility with any older caller but
 * is now vestigial server-side — there is nothing left to destructively
 * replace. Use `unassignMissionCellContributor()` for actual removal.
 */
export async function assignCells(
  missionId: string,
  cells: string[],
  contributorId: string,
  reassign = false,
): Promise<number> {
  const { data, error } = await supabase.schema("enterprise").rpc("assign_mission_cells", {
    p_mission: missionId,
    p_cells: cells,
    p_contributor_id: contributorId,
    p_due_at: null,
    p_reassign: reassign,
  });
  if (error) throw error;
  return data as number;
}

/**
 * Removes ONLY this contributor's own assignment on this cell. Never
 * touches the canonical cell row (score/area_id survive), never touches any
 * other contributor's assignment, and never deletes evidence already
 * submitted — see enterprise.unassign_mission_cell_contributor's own
 * comment (0126).
 */
export async function unassignMissionCellContributor(
  missionId: string,
  targetH3: string,
  contributorId: string,
): Promise<void> {
  const { error } = await supabase.schema("enterprise").rpc("unassign_mission_cell_contributor", {
    p_mission: missionId,
    p_target_h3: targetH3,
    p_contributor_id: contributorId,
  });
  if (error) throw error;
}

/**
 * Recomputes mission_progress from source-of-truth tables and returns the
 * fresh row — one round trip, not a write followed by a separate read.
 * Idempotent: calling this twice with unchanged underlying data returns
 * identical observation_count/sample_count/coverage_pct.
 */
export async function recomputeMissionProgress(missionId: string): Promise<MissionProgress> {
  const { data, error } = await supabase.schema("enterprise")
    .rpc("recompute_mission_progress", { p_mission: missionId })
    .single();
  if (error) throw error;
  return data as MissionProgress;
}

/** Reads the last-computed snapshot without recomputing it. */
export async function fetchMissionProgress(missionId: string): Promise<MissionProgress | null> {
  const { data, error } = await supabase.schema("enterprise")
    .from("mission_progress")
    .select("mission_id,observation_count,sample_count,coverage_pct,updated_at")
    .eq("mission_id", missionId)
    .maybeSingle();
  if (error) throw error;
  return data as MissionProgress | null;
}

export type MissionProgressDetail = {
  per_contributor: Array<{ contributor_id: string; sample_count: number }>;
  outside_assignment_count: number;
  last_activity_at: string | null;
};

/**
 * The per-contributor/outside-assignment/last-activity breakdown.
 *
 * NOT a plain `.from("sample").select()` — enterprise.sample's own RLS
 * (sample_select) only lets a caller see samples they collected themselves,
 * or ones already past review. A manager reading their whole team's numbers
 * needs the RPC's SECURITY DEFINER boundary (gated on mission membership,
 * same as recomputeMissionProgress), or they would silently see only their
 * own rows and report a wrong count that looks like a real one.
 */
export async function fetchMissionProgressDetail(missionId: string): Promise<MissionProgressDetail> {
  const { data, error } = await supabase.schema("enterprise")
    .rpc("mission_progress_detail", { p_mission: missionId });
  if (error) throw error;
  return data as MissionProgressDetail;
}

async function authHeader(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("You must be signed in.");
  return { Authorization: `Bearer ${token}`, "content-type": "application/json" };
}

/** Calls the generate-mission-cells Edge Function — the ONE place H3
 *  polygon-fill math runs (no h3-pg extension exists; see the function's
 *  own header comment). Returns how many NEW cells were created. */
export async function generateMissionCells(missionId: string, areaId: string): Promise<{ totalCells: number; newlyCreated: number }> {
  const res = await fetch(`${FUNCTIONS_URL}/generate-mission-cells`, {
    method: "POST",
    headers: await authHeader(),
    body: JSON.stringify({ missionId, areaId }),
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(body?.detail || body?.error || `Cell generation failed (${res.status})`);
  return { totalCells: body.totalCells, newlyCreated: body.newlyCreated };
}

/**
 * Phase 3 (Solo→Team shared-targeting) — scores cells with the SAME shared
 * TargetingEngine used everywhere else in this pipeline. By default only
 * cells with no score yet are scored (safe to call after every Generate
 * Cells tap without redoing work); `force: true` re-scores everything in
 * scope. Server-authoritative: nothing this function sends is a score, only
 * which mission/area to score.
 */
export async function scoreMissionCells(
  missionId: string,
  opts: { areaId?: string; force?: boolean } = {},
): Promise<{ requested: number; scored: number; persisted: number; cells: Array<{ targetH3: string; score: number }> }> {
  const res = await fetch(`${FUNCTIONS_URL}/score-mission-cells`, {
    method: "POST",
    headers: await authHeader(),
    body: JSON.stringify({ missionId, areaId: opts.areaId, force: opts.force ?? false }),
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(body?.detail || body?.error || `Scoring failed (${res.status})`);
  return body;
}

// ── Phase 2 (Solo→Team shared-targeting): AI Recommended Area ───────────────
// Both calls below hit Edge Functions that run the SAME shared deterministic
// TargetingEngine Solo Exploration uses (shared/geo-core/gie/) — the mobile
// app never scores anything itself here. See team-targeting/handler.ts and
// accept-recommended-area/handler.ts for the server-side implementation.

export type TeamTargetReason = Record<string, unknown>;

export interface TeamTargetCandidate {
  cell: string;
  centre: { lat: number; lng: number };
  bearingDeg: number;
  compass: string;
  distanceM: number;
  /** 0..1, deterministic — never a probability. */
  score: number;
  reportScore: number;
  band: string;
  reasons: TeamTargetReason[];
  commodities: string[];
  scoredForCommodity: string | null;
}

export interface TeamTargetHotspot {
  lat: number; lng: number; cell: string; score: number; liftOverCentre: number;
}

export interface TeamTargetingResult {
  current: { cell: string; score: number };
  targets: TeamTargetCandidate[];
  bestIsHere: boolean;
  hotspot: TeamTargetHotspot | null;
  /** Always shown to the manager verbatim — see the function's own note on
   *  why structural/lithology/terrain evidence isn't in `targets[].score` yet. */
  evidenceCaveat: string;
}

/**
 * PREVIEW only — calls `team-targeting`, which makes no database writes.
 * Nothing is created until the manager explicitly accepts one candidate via
 * `acceptRecommendedArea()` below.
 */
export async function fetchTeamTargetRecommendation(
  lat: number,
  lng: number,
  opts: { commodity?: string | null; radiusM?: number; rings?: number; limit?: number; hotspot?: boolean } = {},
): Promise<TeamTargetingResult> {
  const res = await fetch(`${FUNCTIONS_URL}/team-targeting`, {
    method: "POST",
    headers: await authHeader(),
    body: JSON.stringify({
      lat, lng,
      commodity: opts.commodity ?? undefined,
      radiusM: opts.radiusM, rings: opts.rings, limit: opts.limit,
      hotspot: opts.hotspot ?? false,
    }),
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(body?.detail || body?.error || `Recommendation failed (${res.status})`);
  return body as TeamTargetingResult;
}

export interface AcceptedRecommendedArea {
  areaId: string;
  missionId: string;
  name: string;
  center: { lat: number; lng: number };
  envelopeRings: number;
  cellCount: number;
  sourceTargetH3: string;
  sourceTargetScore: number;
  reportScore: number;
  band: string;
  reasons: TeamTargetReason[];
  commodities: string[];
  scoredForCommodity: string | null;
  evidenceCaveat: string;
}

/**
 * The explicit ACCEPT step — the manager's only action that actually creates
 * an `exploration_area`. The server re-scores `targetH3` fresh and ignores
 * any score the client might send; only `missionId`/`targetH3`/`name`/
 * `commodity` are meaningful inputs (see accept-recommended-area/handler.ts).
 */
export async function acceptRecommendedArea(
  missionId: string,
  targetH3: string,
  name: string,
  commodity?: string | null,
): Promise<AcceptedRecommendedArea> {
  const res = await fetch(`${FUNCTIONS_URL}/accept-recommended-area`, {
    method: "POST",
    headers: await authHeader(),
    body: JSON.stringify({ missionId, targetH3, name, commodity: commodity ?? undefined }),
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(body?.detail || body?.error || `Area creation failed (${res.status})`);
  return body as AcceptedRecommendedArea;
}

// Phase 7 (Solo→Team shared-targeting) — cross-contributor cell synthesis.
// Claude narrates where multiple contributors' evidence for the same cell
// agrees or conflicts; it never sets a score, which is why there's no
// numeric field on this type. The deterministic score stays in
// Assignment.prospectivityScore — this is purely explanatory context.
export type CellSynthesisAgreement = "consistent" | "mixed" | "conflicting" | "insufficient_data";
export interface CellSynthesis {
  id: string;
  contributor_count: number;
  sample_count: number;
  agreement: CellSynthesisAgreement;
  headline: string;
  headline_so: string;
  narrative: string;
  narrative_so: string;
  model?: string;
  created_at?: string;
}

/** Asks Claude to compare every contributor's evidence for one mission cell
 *  and saves the result. Costs an API call — call on demand (a button),
 *  never automatically. */
export async function generateCellSynthesis(missionId: string, targetH3: string): Promise<CellSynthesis> {
  const res = await fetch(`${FUNCTIONS_URL}/enterprise-mission-synthesis`, {
    method: "POST",
    headers: await authHeader(),
    body: JSON.stringify({ missionId, targetH3 }),
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(body?.detail || body?.error || `Synthesis failed (${res.status})`);
  return body as CellSynthesis;
}

/** Returns the last saved synthesis for a cell, or null if none exists yet. */
export async function fetchCellSynthesis(missionId: string, targetH3: string): Promise<CellSynthesis | null> {
  const res = await fetch(
    `${FUNCTIONS_URL}/enterprise-mission-synthesis?missionId=${encodeURIComponent(missionId)}&targetH3=${encodeURIComponent(targetH3)}`,
    { headers: await authHeader() },
  );
  if (res.status === 404) return null;
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(body?.detail || body?.error || `Synthesis lookup failed (${res.status})`);
  return body as CellSynthesis;
}

// Phase 9 (Solo→Team shared-targeting) — a follow-up mission from a source
// mission's best-scoring cell. Provenance (sourceMissionId/sourceTargetH3/
// sourceScore) is set server-side by create_followup_mission, never chosen
// by the client — this wrapper only names the new mission.
export interface FollowupMission {
  missionId: string;
  areaId: string;
  sourceMissionId: string;
  sourceTargetH3: string;
  sourceScore: number;
  envelopeRings: number;
  cellCount: number;
}

export async function createFollowupMission(
  sourceMissionId: string,
  name: string,
  opts: { description?: string; commodity?: string } = {},
): Promise<FollowupMission> {
  const res = await fetch(`${FUNCTIONS_URL}/create-followup-mission`, {
    method: "POST",
    headers: await authHeader(),
    body: JSON.stringify({ sourceMissionId, name, description: opts.description, commodity: opts.commodity }),
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(body?.detail || body?.error || `Follow-up mission creation failed (${res.status})`);
  return body as FollowupMission;
}

/**
 * Deletes a mission outright — a HARD delete (enterprise.delete_mission's
 * own comment explains why this is safe: real field evidence is detached,
 * never destroyed, via the existing FK graph). The RPC re-checks
 * is_mission_manager itself; this wrapper does not pre-filter.
 */
export async function deleteMission(missionId: string): Promise<void> {
  const { error } = await supabase.schema("enterprise").rpc("delete_mission", { p_mission: missionId });
  if (error) throw error;
}

// Manually creates a mission area — no AI recommendation/scoring involved.
// Fills the gap left when "+ AI Recommended Area" finds no evidence near a
// location the manager already knows matters (the server is currently blind
// to structural/terrain/lithology-prior evidence — see
// score-mission-cells's own EVIDENCE_CAVEAT).
export interface ManualArea {
  areaId: string;
  missionId: string;
  name: string;
  center: { lat: number; lng: number };
  envelopeRings: number;
  cellCount: number;
}

export async function createManualArea(
  missionId: string,
  name: string,
  lat: number,
  lng: number,
  rings?: number,
): Promise<ManualArea> {
  const res = await fetch(`${FUNCTIONS_URL}/create-manual-area`, {
    method: "POST",
    headers: await authHeader(),
    body: JSON.stringify({ missionId, name, lat, lng, rings }),
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(body?.detail || body?.error || `Manual area creation failed (${res.status})`);
  return body as ManualArea;
}

// ── Phase 11 — Human Geological Review ──────────────────────────────────────
// The deterministic engine stays authoritative for score/evidence/reasons/
// coverage (Phase 10); this layer only surfaces what's already persisted and
// records a manager's accept/reject/needs-more-data decision on top of it —
// review-area's own header note.

export type AreaReviewStatus = "pending" | "accepted" | "rejected" | "needs_more_data";

/** A cell within the area, WITH its Phase 10 evidence graph — selected
 *  directly, never recomputed, so opening this screen costs one bounded
 *  read (cells already scored by score-mission-cells), not a re-score. */
export type AreaReviewCell = {
  target_h3: string;
  prospectivity_score: number | null;
  integrated_score: number | null;
  evidence_sample_count: number | null;
  reasons: TeamTargetReason[] | null;
  coverage: { roles: Array<{ role: string; state: string }>; present: number; total: number; unavailable: string[] } | null;
  evidence: Array<{ item: { statement: string; weight: number; tier?: string }; role: string }> | null;
};

export interface AreaReviewDetail {
  areaId: string;
  name: string;
  reviewStatus: AreaReviewStatus;
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewNotes: string | null;
  reviewerRole: string | null;
  sourceTargetH3: string | null;
  sourceTargetScore: number | null;
  sourceCommodity: string | null;
  cells: AreaReviewCell[];
}

/** Everything the review screen needs, in the two bounded reads it actually
 *  requires — the area's own row (review state + AI-recommendation
 *  provenance, if any), and this area's own cells (already-scored, Phase 10
 *  evidence graph included). Never touches other areas/missions. */
export async function fetchAreaReviewDetail(missionId: string, areaId: string): Promise<AreaReviewDetail> {
  const [{ data: area, error: areaError }, { data: cells, error: cellsError }] = await Promise.all([
    supabase.schema("enterprise").from("exploration_area")
      .select("id,name,review_status,reviewed_by,reviewed_at,review_notes,reviewer_role,source_target_h3,source_target_score,source_commodity")
      .eq("id", areaId).maybeSingle(),
    supabase.schema("enterprise").from("mission_assignment")
      .select("target_h3,prospectivity_score,integrated_score,evidence_sample_count,reasons,coverage,evidence")
      .eq("mission_id", missionId).eq("area_id", areaId).is("contributor_id", null)
      .order("prospectivity_score", { ascending: false, nullsFirst: false }),
  ]);
  if (areaError) throw areaError;
  if (cellsError) throw cellsError;
  if (!area) throw new Error("Area not found");
  return {
    areaId: (area as any).id,
    name: (area as any).name,
    reviewStatus: (area as any).review_status,
    reviewedBy: (area as any).reviewed_by,
    reviewedAt: (area as any).reviewed_at,
    reviewNotes: (area as any).review_notes,
    reviewerRole: (area as any).reviewer_role,
    sourceTargetH3: (area as any).source_target_h3,
    sourceTargetScore: (area as any).source_target_score,
    sourceCommodity: (area as any).source_commodity,
    cells: (cells ?? []) as AreaReviewCell[],
  };
}

export interface AreaReviewResult {
  areaId: string;
  reviewStatus: AreaReviewStatus;
  reviewedBy: string;
  reviewedAt: string;
}

/** Records the human review decision. Server-authoritative: reviewedBy/
 *  reviewedAt come back from the RPC's own auth.uid()/now(), never echoed
 *  from anything sent here — see review-area's own security tests. */
export async function reviewArea(
  missionId: string,
  areaId: string,
  decision: Exclude<AreaReviewStatus, "pending">,
  notes?: string,
): Promise<AreaReviewResult> {
  const res = await fetch(`${FUNCTIONS_URL}/review-area`, {
    method: "POST",
    headers: await authHeader(),
    body: JSON.stringify({ missionId, areaId, decision, notes }),
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(body?.detail || body?.error || `Area review failed (${res.status})`);
  return body as AreaReviewResult;
}

// ── Phase 12 — "Why A > B" comparative reasoning ────────────────────────────
// Purely deterministic: reads the SAME reasons/coverage/score Phase 10
// already persisted, via compare-areas → enterprise.compare_mission_areas.
// No AI, no recomputation — see that RPC's own header note.

export interface AreaComparisonSide {
  area_id: string;
  name: string;
  review_status: AreaReviewStatus;
  target_h3: string | null;
  score: number | null;
  integrated_score: number | null;
  reasons: TeamTargetReason[] | null;
  coverage: { roles: Array<{ role: string; state: string }>; present: number; total: number; unavailable: string[] } | null;
}

export interface AreaComparison {
  area_a: AreaComparisonSide;
  area_b: AreaComparisonSide;
  diff: {
    score_delta: number | null;
    roles_only_in_a: string[];
    roles_only_in_b: string[];
    reason_kinds_only_in_a: string[];
    reason_kinds_only_in_b: string[];
  };
}

export async function compareMissionAreas(missionId: string, areaIdA: string, areaIdB: string): Promise<AreaComparison> {
  const res = await fetch(`${FUNCTIONS_URL}/compare-areas`, {
    method: "POST",
    headers: await authHeader(),
    body: JSON.stringify({ missionId, areaIdA, areaIdB }),
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(body?.detail || body?.error || `Area comparison failed (${res.status})`);
  return body as AreaComparison;
}

// ── Phase 13 — Geological analogue matching ─────────────────────────────────
// Real, named occurrences elsewhere sharing an area's commodity (and
// deposit_type when recorded) — see area-geological-analogues's own header
// note. No invented similarity score, no AI.

export interface AreaAnalogue {
  name: string | null;
  commodity_key: string | null;
  deposit_type: string | null;
  host_rocks: string[] | null;
  reference: string | null;
  shares_deposit_type: boolean;
}

export interface AreaAnaloguesResult {
  target_h3: string | null;
  commodities: string[];
  deposit_style_ontology_populated: boolean;
  analogues: AreaAnalogue[];
  note: string | null;
}

export async function fetchAreaGeologicalAnalogues(
  missionId: string, areaId: string, limit?: number,
): Promise<AreaAnaloguesResult> {
  const res = await fetch(`${FUNCTIONS_URL}/area-geological-analogues`, {
    method: "POST",
    headers: await authHeader(),
    body: JSON.stringify({ missionId, areaId, limit }),
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(body?.detail || body?.error || `Analogue lookup failed (${res.status})`);
  return body as AreaAnaloguesResult;
}

// ── Phase 14 — Unified Target Report ────────────────────────────────────────
// Pure aggregation of Phase 7/10/11's already-persisted data into one
// document — see target-report's own header note. No new computation.

export interface TargetReport {
  mission_id: string;
  area: {
    area_id: string; name: string; review_status: AreaReviewStatus;
    reviewed_by: string | null; reviewed_at: string | null; review_notes: string | null; reviewer_role: string | null;
    source_target_h3: string | null; source_target_score: number | null; source_commodity: string | null;
    created_at: string;
  };
  target: {
    target_h3?: string; score?: number | null; scored_at?: string | null;
    integrated_score?: number | null; evidence_sample_count?: number | null;
    reasons?: TeamTargetReason[] | null; coverage?: AreaReviewCell["coverage"]; evidence?: AreaReviewCell["evidence"];
    note?: string;
  };
  ai_synthesis: {
    headline: string; headline_so: string | null; narrative: string; narrative_so: string | null;
    agreement: CellSynthesisAgreement; contributor_count: number; sample_count: number; generated_at: string;
  } | null;
  /** Phase 16 — informational only. Never part of `target.score`/`reasons`;
   *  null until a manager explicitly requests one via computeAreaSpectralIndex. */
  spectral: {
    index_name: string; value: number | null; acquisition_date: string;
    cloud_fraction: number | null; valid_pixel_fraction: number | null;
    resolution_m: number; source: string; computed_at: string;
  } | null;
}

export async function fetchTargetReport(missionId: string, areaId: string): Promise<TargetReport> {
  const res = await fetch(`${FUNCTIONS_URL}/target-report`, {
    method: "POST",
    headers: await authHeader(),
    body: JSON.stringify({ missionId, areaId }),
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(body?.detail || body?.error || `Target report failed (${res.status})`);
  return body as TargetReport;
}

// ── Phase 16 — Remote-Sensing Spectral Intelligence ─────────────────────────
// Iron Oxide Ratio (Sentinel-2 B04/B02), computed server-side on explicit
// request — see area-spectral-index's own header note for the quota
// discipline (small fixed AOI, one index, 14-day cache). Informational only:
// this value never feeds the deterministic score.

export interface AreaSpectralIndex {
  index_name: string; value: number | null; acquisition_date: string;
  cloud_fraction: number | null; valid_pixel_fraction: number | null;
  resolution_m: number; source: string; computed_at: string;
  cacheHit: boolean; note?: string;
}

export async function computeAreaSpectralIndex(missionId: string, areaId: string): Promise<AreaSpectralIndex> {
  const res = await fetch(`${FUNCTIONS_URL}/area-spectral-index`, {
    method: "POST",
    headers: await authHeader(),
    body: JSON.stringify({ missionId, areaId }),
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(body?.detail || body?.error || `Spectral analysis failed (${res.status})`);
  return body as AreaSpectralIndex;
}
