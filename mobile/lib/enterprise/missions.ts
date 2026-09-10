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
};

export type MissionContributor = {
  contributor_id: string;
  email: string;
  role: ContributorRole;
  added_at: string;
};

export type MissionArea = { area_id: string; name: string };

export type MyProject = { id: string; name: string; organization_id: string | null; owner_id: string | null };

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
export async function fetchMissionAssignments(missionId: string): Promise<Assignment[]> {
  const { data, error } = await supabase.schema("enterprise")
    .from("mission_assignment")
    .select("id,target_h3,contributor_id,status,due_at,area_id,created_at")
    .eq("mission_id", missionId)
    .order("target_h3");
  if (error) throw error;
  return data ?? [];
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
