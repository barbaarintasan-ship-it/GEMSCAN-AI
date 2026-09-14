// create-followup-mission Edge Function — Phase 9 (Solo→Team shared-targeting).
//
// A mission's best-scoring cell is often exactly where the NEXT mission
// should start — a tighter, more focused sweep of the ground that already
// showed the strongest deterministic signal. This function:
//   1. reads the source mission's best-scoring cell (prospectivity_score,
//      the validated baseline — NEVER integrated_score, which Phase 8's own
//      invariant keeps informational-only and out of ranking decisions),
//   2. builds the SAME small H3-neighbourhood envelope accept-recommended-area
//      uses for an accepted recommendation,
//   3. creates the new mission AND its starting area atomically via
//      enterprise.create_followup_mission, which re-verifies the (cell,
//      score) pair against the source mission itself — never trusts this
//      function's own read.
//
// NOT an AI call. Deterministic geological intelligence only — the new
// mission inherits ground the shared TargetingEngine already scored, nothing
// this function invents.
import { corsHeaders } from "../_shared/cors.ts";
import { BadRequestError, errorResponse, json } from "../_shared/enterprise/errors.ts";
import { resolveActor as realResolveActor, type Actor } from "../_shared/enterprise/auth.ts";
import { userClient, type DbClient } from "../_shared/enterprise/clients.ts";
import { cellCentre, cellBoundaryRing, kRing } from "../_shared/geocontext/h3.ts";

// Same operational default as accept-recommended-area's EXPLORATION_ENVELOPE_RINGS
// — see that file's own header note for why 1 ring, not a geological measurement.
export const FOLLOWUP_ENVELOPE_RINGS = 1;

export interface BestCell {
  targetH3: string;
  score: number;
}

export interface FollowupMissionResponse {
  missionId: string;
  areaId: string;
  sourceMissionId: string;
  sourceTargetH3: string;
  sourceScore: number;
  envelopeRings: number;
  cellCount: number;
}

export interface CreateFollowupMissionDeps {
  resolveActor: (req: Request) => Promise<Actor>;
  userClient: (req: Request) => DbClient;
  /** The source mission's best-scoring canonical cell — a plain read (RLS-visible
   *  to any project member, same as cellsToScore in score-mission-cells); the
   *  RPC re-verifies it before trusting it for anything. Null when no cell in
   *  the mission has been scored yet. */
  bestCell: (req: Request, sourceMissionId: string) => Promise<BestCell | null>;
}

async function defaultBestCell(req: Request, sourceMissionId: string): Promise<BestCell | null> {
  const { data, error } = await userClient(req)
    .schema("enterprise")
    .from("mission_assignment")
    .select("target_h3,prospectivity_score")
    .eq("mission_id", sourceMissionId)
    .is("contributor_id", null)
    .not("prospectivity_score", "is", null)
    .order("prospectivity_score", { ascending: false })
    .limit(1);
  if (error) throw new BadRequestError(error.message);
  const row = (data ?? [])[0] as { target_h3: string; prospectivity_score: number } | undefined;
  return row ? { targetH3: row.target_h3, score: row.prospectivity_score } : null;
}

export const defaultDeps: CreateFollowupMissionDeps = {
  resolveActor: realResolveActor,
  userClient: (req) => userClient(req),
  bestCell: defaultBestCell,
};

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

/** Same k-ring MultiPolygon envelope accept-recommended-area builds — see that
 *  file's own comment on why adjacent hexagons as separate polygon components
 *  is valid MultiPolygon geometry with no union/dissolve needed. */
function envelopeGeoJson(targetH3: string, rings: number): { geojson: string; cellCount: number } {
  const cells = kRing(targetH3, rings);
  const coordinates = cells.map((c) => [cellBoundaryRing(c)]);
  return {
    geojson: JSON.stringify({ type: "MultiPolygon", coordinates }),
    cellCount: cells.length,
  };
}

export async function handleCreateFollowupMission(
  req: Request,
  deps: CreateFollowupMissionDeps = defaultDeps,
): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    await deps.resolveActor(req); // verifies the JWT; the RPC itself re-derives auth.uid() from the forwarded token.

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const sourceMissionId = str(body.sourceMissionId);
    const name = str(body.name);
    const description = str(body.description);
    const commodity = str(body.commodity);

    if (!sourceMissionId) throw new BadRequestError("sourceMissionId is required");
    if (!name) throw new BadRequestError("name is required");

    const best = await deps.bestCell(req, sourceMissionId);
    if (!best) {
      throw new BadRequestError(
        "the source mission has no scored cells yet — run Score Cells before creating a follow-up mission",
      );
    }

    const { geojson, cellCount } = envelopeGeoJson(best.targetH3, FOLLOWUP_ENVELOPE_RINGS);
    const centre = cellCentre(best.targetH3);

    const client = deps.userClient(req);
    const { data, error } = await client.schema("enterprise").rpc("create_followup_mission", {
      p_source_mission: sourceMissionId,
      p_name: name,
      p_description: description,
      p_target_h3: best.targetH3,
      p_target_score: best.score,
      p_center_lat: centre.lat,
      p_center_lng: centre.lng,
      p_boundary_geojson: geojson,
      p_envelope_rings: FOLLOWUP_ENVELOPE_RINGS,
      p_commodity: commodity,
    });
    if (error) throw new BadRequestError(error.message);

    const result = data as { mission_id: string; area_id: string };
    const response: FollowupMissionResponse = {
      missionId: result.mission_id,
      areaId: result.area_id,
      sourceMissionId,
      sourceTargetH3: best.targetH3,
      sourceScore: best.score,
      envelopeRings: FOLLOWUP_ENVELOPE_RINGS,
      cellCount,
    };
    return json(response, 201);
  } catch (err) {
    return errorResponse(err);
  }
}
