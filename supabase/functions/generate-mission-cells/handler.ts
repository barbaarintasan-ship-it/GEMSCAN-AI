// generate-mission-cells — Phase 2B.
//
// POST { missionId, areaId } -> enumerates the H3 cells covering
// enterprise.exploration_area.boundary and persists them via
// enterprise.generate_mission_cells(). H3 polygon-fill (h3-js) cannot run in
// Postgres (no h3-pg extension in this project), so it happens here, in the
// one Deno runtime that already imports h3-js server-side (see
// _shared/geocontext/h3.ts) — the resolution constant is the SAME shared one
// both runtimes already use, not a new one.
//
// This function acts ONLY as the caller (their forwarded JWT via
// userClient()) — never service role. Both the geometry read
// (area_boundary_geojson) and the write (generate_mission_cells) are
// SECURITY DEFINER RPCs that make their own auth.uid()-based authorization
// decision, exactly like Phase 2A. This function adds no privilege of its
// own; it only does the H3 math Postgres cannot.
import { BadRequestError, errorResponse, json, NotFoundError } from "../_shared/enterprise/errors.ts";
import { resolveActor as realResolveActor, type Actor } from "../_shared/enterprise/auth.ts";
import { userClient as realUserClient, type DbClient } from "../_shared/enterprise/clients.ts";
import { H3_RESOLUTION } from "../../../shared/geo-core/geo/h3.ts";
import { fillMultiPolygon, InvalidAreaGeometryError, type GeoJsonMultiPolygon } from "./h3fill.ts";

export interface Deps {
  resolveActor: (req: Request) => Promise<Actor>;
  userClient: (req: Request) => DbClient;
}

export const defaultDeps: Deps = {
  resolveActor: realResolveActor,
  userClient: realUserClient,
};

export async function handleGenerateMissionCells(req: Request, deps: Deps = defaultDeps): Promise<Response> {
  try {
    await deps.resolveActor(req); // verifies the JWT is valid; the actor id itself is unused here — every downstream RPC re-derives auth.uid() from the same token.

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const missionId = typeof body.missionId === "string" ? body.missionId : "";
    const areaId = typeof body.areaId === "string" ? body.areaId : "";
    if (!missionId || !areaId) {
      throw new BadRequestError("missionId and areaId are required");
    }

    const client = deps.userClient(req);

    const { data: geojsonText, error: geoErr } = await client.rpc("area_boundary_geojson", { p_area: areaId });
    if (geoErr) throw new BadRequestError(geoErr.message);
    if (!geojsonText) {
      throw new NotFoundError("area not found, has no boundary, or is not accessible to this account");
    }

    let geojson: GeoJsonMultiPolygon;
    try {
      geojson = JSON.parse(geojsonText as string);
    } catch {
      throw new BadRequestError("area boundary is not valid GeoJSON");
    }

    const cells = fillMultiPolygon(geojson, H3_RESOLUTION);

    const { data: insertedCount, error: rpcErr } = await client.rpc("generate_mission_cells", {
      p_mission: missionId,
      p_area_id: areaId,
      p_cells: cells,
    });
    if (rpcErr) throw new BadRequestError(rpcErr.message);

    return json({
      success: true,
      resolution: H3_RESOLUTION,
      totalCells: cells.length,
      newlyCreated: insertedCount,
    });
  } catch (err) {
    if (err instanceof InvalidAreaGeometryError) {
      return json({ error: err.message, code: "invalid_area_geometry" }, 422);
    }
    return errorResponse(err);
  }
}
