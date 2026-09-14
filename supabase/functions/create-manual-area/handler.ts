// create-manual-area Edge Function.
//
// Fills a real gap in "+ AI Recommended Area" (Phase 2): that flow only ever
// creates an area when the shared TargetingEngine finds at least one
// candidate cell with occurrence/association/community/geology-unit
// evidence near the given point — and, until a server-side pack equivalent
// exists, the server is BLIND to structural (fault/contact), terrain and
// lithology-prior evidence (see score-mission-cells's own EVIDENCE_CAVEAT).
// A manager who already knows a location matters — e.g. they can see a
// mapped fault with their own eyes — had no way to act on that knowledge:
// "no evidence found near this point" left them stuck with nothing to
// Generate Cells against.
//
// This function creates the SAME k-ring MultiPolygon envelope
// accept-recommended-area builds, around a manager-chosen centre, with NO
// scoring step and NO evidence requirement — origin='user', honestly, never
// 'ai_recommended'.
import { corsHeaders } from "../_shared/cors.ts";
import { BadRequestError, errorResponse, json } from "../_shared/enterprise/errors.ts";
import { resolveActor as realResolveActor, type Actor } from "../_shared/enterprise/auth.ts";
import { userClient, type DbClient } from "../_shared/enterprise/clients.ts";
import { cellFor, cellBoundaryRing, kRing } from "../_shared/geocontext/h3.ts";

// A manually chosen area gets a slightly larger default envelope than an
// AI-accepted one (EXPLORATION_ENVELOPE_RINGS=1, accept-recommended-area) —
// there is no scored target narrowing it to one specific cell here, so 2
// rings (19 cells, ~100 km² at resolution 7) gives a manager room to cover
// the feature they actually saw, still bounded to a small area a team can
// realistically divide work across.
export const MANUAL_AREA_ENVELOPE_RINGS = 2;

export interface ManualAreaResponse {
  areaId: string;
  missionId: string;
  name: string;
  center: { lat: number; lng: number };
  envelopeRings: number;
  cellCount: number;
}

export interface CreateManualAreaDeps {
  resolveActor: (req: Request) => Promise<Actor>;
  userClient: (req: Request) => DbClient;
}

export const defaultDeps: CreateManualAreaDeps = {
  resolveActor: realResolveActor,
  userClient: (req) => userClient(req),
};

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}
function num(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : (v as number);
  return Number.isFinite(n) ? n : null;
}

/** Same k-ring MultiPolygon envelope accept-recommended-area builds — see
 *  that file's own comment on why adjacent hexagons as separate polygon
 *  components is valid MultiPolygon geometry with no union/dissolve needed. */
function envelopeGeoJson(centreCell: string, rings: number): { geojson: string; cellCount: number } {
  const cells = kRing(centreCell, rings);
  const coordinates = cells.map((c) => [cellBoundaryRing(c)]);
  return {
    geojson: JSON.stringify({ type: "MultiPolygon", coordinates }),
    cellCount: cells.length,
  };
}

export async function handleCreateManualArea(
  req: Request,
  deps: CreateManualAreaDeps = defaultDeps,
): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    await deps.resolveActor(req); // verifies the JWT; the RPC itself re-derives auth.uid() from the forwarded token.

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const missionId = str(body.missionId);
    const name = str(body.name);
    const lat = num(body.lat);
    const lng = num(body.lng);
    const rings = num(body.rings) ?? MANUAL_AREA_ENVELOPE_RINGS;

    if (!missionId) throw new BadRequestError("missionId is required");
    if (!name) throw new BadRequestError("name is required");
    if (lat == null || lng == null || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      throw new BadRequestError("lat/lng must be valid coordinates");
    }
    if (!Number.isInteger(rings) || rings < 1 || rings > 5) {
      throw new BadRequestError("rings must be an integer between 1 and 5");
    }

    const centreCell = cellFor(lat, lng);
    const { geojson, cellCount } = envelopeGeoJson(centreCell, rings);

    const client = deps.userClient(req);
    const { data: areaId, error } = await client.schema("enterprise").rpc("create_manual_mission_area", {
      p_mission: missionId,
      p_name: name,
      p_center_lat: lat,
      p_center_lng: lng,
      p_boundary_geojson: geojson,
      p_envelope_rings: rings,
    });
    if (error) throw new BadRequestError(error.message);

    const response: ManualAreaResponse = {
      areaId: areaId as string,
      missionId,
      name,
      center: { lat, lng },
      envelopeRings: rings,
      cellCount,
    };
    return json(response, 201);
  } catch (err) {
    return errorResponse(err);
  }
}
