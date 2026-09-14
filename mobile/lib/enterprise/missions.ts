// Team Mission Mode — client wrapper over the mission/H3-assignment RPCs
// built server-side (Phase 2A/2B/2C). Same shape as lib/enterprise/team.ts:
// deliberately dumb, authorization lives entirely in the RPCs/RLS.
import { supabase } from "../supabase";

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
  const { data: auth } = await supabase.auth.getUser();
  const uid = auth.user?.id;
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

/** Every assignment (assigned + unassigned pool) for a mission. */
/**
 * Ranked best-first: highest prospectivity_score first (nulls — not yet
 * scored — last), then nearer-to-area-centre... except distance-to-centre
 * isn't available on this row, so the deterministic tie-breaker is
 * target_h3 itself (stable, always distinct) — same spirit as Solo's
 * `rank()` tie-break (nearer wins), just the nearest deterministic
 * equivalent available at this granularity without inventing a new
 * geological weighting for ties.
 */
export async function fetchMissionAssignments(missionId: string): Promise<Assignment[]> {
  const { data, error } = await supabase.schema("enterprise")
    .from("mission_assignment")
    .select("id,target_h3,contributor_id,status,due_at,area_id,created_at,prospectivity_score,scored_at")
    .eq("mission_id", missionId);
  if (error) throw error;
  const rows = data ?? [];
  rows.sort((a, b) => {
    const sa = a.prospectivity_score, sb = b.prospectivity_score;
    if (sa == null && sb == null) return a.target_h3.localeCompare(b.target_h3);
    if (sa == null) return 1;
    if (sb == null) return -1;
    if (sb !== sa) return sb - sa;
    return a.target_h3.localeCompare(b.target_h3);
  });
  return rows;
}

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
  const { data: auth } = await supabase.auth.getUser();
  const uid = auth.user?.id;
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
