// target-report Edge Function — Phase 14 (Geological Intelligence
// Transformation).
//
// The Unified Target Report: PURE AGGREGATION of what Phases 7/10/11
// already computed and persisted — no recomputed score, no new AI call.
// Calls enterprise.get_target_report, which assembles exploration_area
// (Phase 11 review state), mission_assignment (Phase 10 evidence graph),
// and cell_synthesis (Phase 7 AI narrative, when one exists) into one
// document. See 0149's own header note.
//
//   POST /target-report  { missionId, areaId }
import { corsHeaders } from "../_shared/cors.ts";
import { BadRequestError, errorResponse, json } from "../_shared/enterprise/errors.ts";
import { resolveActor as realResolveActor, type Actor } from "../_shared/enterprise/auth.ts";
import { userClient, type DbClient } from "../_shared/enterprise/clients.ts";

export interface TargetReportDeps {
  resolveActor: (req: Request) => Promise<Actor>;
  userClient: (req: Request) => DbClient;
}

export const defaultDeps: TargetReportDeps = {
  resolveActor: realResolveActor,
  userClient: (req) => userClient(req),
};

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

export async function handleTargetReport(
  req: Request,
  deps: TargetReportDeps = defaultDeps,
): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    await deps.resolveActor(req); // verifies the JWT; the RPC re-derives auth.uid() from the forwarded token.

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const missionId = str(body.missionId);
    const areaId = str(body.areaId);

    if (!missionId) throw new BadRequestError("missionId is required");
    if (!areaId) throw new BadRequestError("areaId is required");

    const client = deps.userClient(req);
    const { data, error } = await client.schema("enterprise").rpc("get_target_report", {
      p_mission: missionId,
      p_area: areaId,
    });
    if (error) throw new BadRequestError(error.message);

    return json(data, 200);
  } catch (err) {
    return errorResponse(err);
  }
}
