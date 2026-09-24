// compare-areas Edge Function — Phase 12 (Geological Intelligence Transformation).
//
// "Why A > B": a read-only, purely deterministic comparison of two areas in
// the same mission. Calls enterprise.compare_mission_areas, which reads the
// SAME prospectivity_score/reasons/coverage Phase 10 already persisted on
// mission_assignment and returns a structured diff — no recomputation, no AI
// call, no second scoring engine. See 0147's own header note for the full
// architecture rationale.
//
//   POST /compare-areas  { missionId, areaIdA, areaIdB }
import { corsHeaders } from "../_shared/cors.ts";
import { BadRequestError, errorResponse, json } from "../_shared/enterprise/errors.ts";
import { resolveActor as realResolveActor, type Actor } from "../_shared/enterprise/auth.ts";
import { userClient, type DbClient } from "../_shared/enterprise/clients.ts";

export interface CompareAreasDeps {
  resolveActor: (req: Request) => Promise<Actor>;
  userClient: (req: Request) => DbClient;
}

export const defaultDeps: CompareAreasDeps = {
  resolveActor: realResolveActor,
  userClient: (req) => userClient(req),
};

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

export async function handleCompareAreas(
  req: Request,
  deps: CompareAreasDeps = defaultDeps,
): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    await deps.resolveActor(req); // verifies the JWT; the RPC re-derives auth.uid() from the forwarded token.

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const missionId = str(body.missionId);
    const areaIdA = str(body.areaIdA);
    const areaIdB = str(body.areaIdB);

    if (!missionId) throw new BadRequestError("missionId is required");
    if (!areaIdA) throw new BadRequestError("areaIdA is required");
    if (!areaIdB) throw new BadRequestError("areaIdB is required");
    if (areaIdA === areaIdB) throw new BadRequestError("areaIdA and areaIdB must be different areas");

    const client = deps.userClient(req);
    const { data, error } = await client.schema("enterprise").rpc("compare_mission_areas", {
      p_mission: missionId,
      p_area_a: areaIdA,
      p_area_b: areaIdB,
    });
    if (error) throw new BadRequestError(error.message);

    return json(data, 200);
  } catch (err) {
    return errorResponse(err);
  }
}
