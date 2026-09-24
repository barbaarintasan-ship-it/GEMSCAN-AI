// area-geological-analogues Edge Function — Phase 13 (Geological
// Intelligence Transformation).
//
// Read-only: calls enterprise.area_geological_analogues, which matches an
// area's best cell against REAL, NAMED occurrences elsewhere sharing its
// commodity (and deposit_type when recorded) — no invented similarity
// score, no ML, no AI call. See 0148's own header note for why
// deposit_style_id (the clean ontology link) isn't used: it's 0% populated
// in production today, and the RPC says so explicitly rather than letting
// an empty result read as "no analogues exist".
//
//   POST /area-geological-analogues  { missionId, areaId, limit? }
import { corsHeaders } from "../_shared/cors.ts";
import { BadRequestError, errorResponse, json } from "../_shared/enterprise/errors.ts";
import { resolveActor as realResolveActor, type Actor } from "../_shared/enterprise/auth.ts";
import { userClient, type DbClient } from "../_shared/enterprise/clients.ts";

export interface AreaAnaloguesDeps {
  resolveActor: (req: Request) => Promise<Actor>;
  userClient: (req: Request) => DbClient;
}

export const defaultDeps: AreaAnaloguesDeps = {
  resolveActor: realResolveActor,
  userClient: (req) => userClient(req),
};

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

export async function handleAreaGeologicalAnalogues(
  req: Request,
  deps: AreaAnaloguesDeps = defaultDeps,
): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    await deps.resolveActor(req); // verifies the JWT; the RPC re-derives auth.uid() from the forwarded token.

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const missionId = str(body.missionId);
    const areaId = str(body.areaId);
    const limitRaw = typeof body.limit === "number" ? body.limit : null;
    const limit = limitRaw != null ? Math.max(1, Math.min(MAX_LIMIT, Math.trunc(limitRaw))) : DEFAULT_LIMIT;

    if (!missionId) throw new BadRequestError("missionId is required");
    if (!areaId) throw new BadRequestError("areaId is required");

    const client = deps.userClient(req);
    const { data, error } = await client.schema("enterprise").rpc("area_geological_analogues", {
      p_mission: missionId,
      p_area: areaId,
      p_limit: limit,
    });
    if (error) throw new BadRequestError(error.message);

    return json(data, 200);
  } catch (err) {
    return errorResponse(err);
  }
}
