// accept-recommended-area Edge Function — Phase 2 (Solo→Team shared-targeting).
//
// The write half of "AI Recommended Area". `team-targeting` (Phase 1) is the
// read-only PREVIEW: a manager calls it to see ranked candidates. This
// function is the ACCEPT step: given the one cell a manager chose, it
//   1. re-derives that cell's centre from H3 geometry alone (never from
//      client-supplied lat/lng — a cell id is the only thing trusted),
//   2. RE-SCORES it fresh via the SAME shared TargetingEngine.targetAt()
//      Phase 1 built (never trusts a client-supplied score — see the
//      module-level comment below and enterprise.create_mission_area_from_target's
//      own comment, which independently refuses to trust one too),
//   3. builds a small H3-neighbourhood envelope polygon around it,
//   4. persists it as a real enterprise.exploration_area, linked to the
//      mission, via the SAME manager-authorization boundary every other
//      mission-mutating RPC uses (is_mission_manager).
//
// This is the manager's explicit "accept" action — nothing before this call
// writes anything. `team-targeting` never creates an area on its own.
//
// NOT an AI call. Deterministic geological intelligence only.
import { corsHeaders } from "../_shared/cors.ts";
import { BadRequestError, errorResponse, json } from "../_shared/enterprise/errors.ts";
import { resolveActor as realResolveActor, type Actor } from "../_shared/enterprise/auth.ts";
import { serviceClient, userClient, type DbClient } from "../_shared/enterprise/clients.ts";
import { makeServerGeoContext } from "../_shared/geocontext/serverGeoContext.ts";
import { cellFor, cellCentre, kRing, cellBoundaryRing } from "../_shared/geocontext/h3.ts";
import { TargetingEngine, type H3Ops, type ExplorationTarget } from "../../../shared/geo-core/gie/targetingEngine.ts";

/**
 * How many H3 k-rings around the accepted target cell make up the area's
 * working envelope.
 *
 * THIS IS AN OPERATIONAL DEFAULT, NOT A GEOLOGICAL MEASUREMENT — nothing in
 * the validated targeting model says a mineralised cell's "neighbourhood" is
 * any particular size; the ranking model has no opinion beyond the single
 * cell it scored. One ring (the target cell + its 6 immediate neighbours,
 * 7 cells, ~36 km² at resolution 7) is chosen because:
 *   - it is the smallest H3 neighbourhood larger than one cell, so the
 *     resulting area is never JUST the single scored cell (see Phase 2 spec:
 *     "AI Recommended Area is not the same thing as one H3 cell"),
 *   - it stays tightly centred on the actual recommendation rather than
 *     diluting it with distant, unscored ground,
 *   - 7 cells is enough for a small team to divide work across via the
 *     EXISTING generate-mission-cells / assign_mission_cells flow (Phase 3+)
 *     without the manager needing to draw anything.
 * Recorded on the created area (`source_envelope_rings`) precisely so this
 * number can be revisited later without guessing what a given area used.
 */
export const EXPLORATION_ENVELOPE_RINGS = 1;

const H3_OPS: H3Ops = { cellFor, cellCentre, kRing };

export interface AcceptedAreaResponse {
  areaId: string;
  missionId: string;
  name: string;
  center: { lat: number; lng: number };
  envelopeRings: number;
  cellCount: number;
  sourceTargetH3: string;
  /** The score the SERVER recomputed at accept time — never the client's. */
  sourceTargetScore: number;
  reportScore: number;
  band: string;
  reasons: unknown[];
  commodities: string[];
  scoredForCommodity: string | null;
  evidenceCaveat: string;
}

export interface AcceptRecommendedAreaDeps {
  resolveActor: (req: Request) => Promise<Actor>;
  userClient: (req: Request) => DbClient;
  /** Re-scores one H3 cell fresh — server-authoritative, never client-trusted. */
  scoreTarget: (cell: string, commodity: string | null) => Promise<ExplorationTarget | null>;
}

const EVIDENCE_CAVEAT =
  "Structural (fault/contact), lithology-prior and terrain-prior evidence are " +
  "not yet available server-side (they need a live equivalent of the mobile " +
  "bundled pack, not built yet). Occurrence, association, community and " +
  "geology-unit evidence are included in this score.";

export const defaultDeps: AcceptRecommendedAreaDeps = {
  resolveActor: realResolveActor,
  userClient: (req) => userClient(req),
  scoreTarget: (cell, commodity) => {
    const geo = makeServerGeoContext(serviceClient());
    const engine = new TargetingEngine(geo, H3_OPS);
    const centre = cellCentre(cell);
    return engine.targetAt(centre, centre, { commodity });
  },
};

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

/** Builds a GeoJSON MultiPolygon from the k-ring's hexagon boundaries — no
 *  union/dissolve of shared edges is needed: adjacent hexagons as separate
 *  polygon components is valid MultiPolygon geometry, and PostGIS/ST_Union
 *  is not required for area membership or generate-mission-cells's own
 *  ST_Contains-based cell fill (0058/0116), which only needs a valid
 *  geometry to test points/polygons against. */
function envelopeGeoJson(targetH3: string, rings: number): { geojson: string; cellCount: number } {
  const cells = kRing(targetH3, rings);
  const coordinates = cells.map((c) => [cellBoundaryRing(c)]);
  return {
    geojson: JSON.stringify({ type: "MultiPolygon", coordinates }),
    cellCount: cells.length,
  };
}

export async function handleAcceptRecommendedArea(
  req: Request,
  deps: AcceptRecommendedAreaDeps = defaultDeps,
): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    await deps.resolveActor(req); // verifies the JWT; the RPC itself re-derives auth.uid() from the forwarded token, exactly like generate-mission-cells.

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const missionId = str(body.missionId);
    const targetH3 = str(body.targetH3);
    const name = str(body.name);
    const commodity = str(body.commodity);

    if (!missionId) throw new BadRequestError("missionId is required");
    if (!name) throw new BadRequestError("name is required");
    if (!targetH3 || !/^[0-9a-f]{15}$/.test(targetH3)) {
      throw new BadRequestError("targetH3 must be a well-formed H3 cell index");
    }

    // Server-authoritative re-score. Whatever score the client displayed
    // during preview is discarded here — this is the number that gets stored.
    const target = await deps.scoreTarget(targetH3, commodity);
    if (!target) {
      throw new BadRequestError(
        "this cell currently has no supporting evidence — the recommendation may be stale, request a fresh one",
      );
    }

    const { geojson, cellCount } = envelopeGeoJson(targetH3, EXPLORATION_ENVELOPE_RINGS);
    const centre = cellCentre(targetH3);

    const client = deps.userClient(req);
    const { data: areaId, error } = await client.schema("enterprise").rpc("create_mission_area_from_target", {
      p_mission: missionId,
      p_name: name,
      p_center_lat: centre.lat,
      p_center_lng: centre.lng,
      p_boundary_geojson: geojson,
      p_target_h3: targetH3,
      p_target_score: target.score,
      p_commodity: commodity,
      p_envelope_rings: EXPLORATION_ENVELOPE_RINGS,
    });
    if (error) throw new BadRequestError(error.message);

    const response: AcceptedAreaResponse = {
      areaId: areaId as string,
      missionId,
      name,
      center: centre,
      envelopeRings: EXPLORATION_ENVELOPE_RINGS,
      cellCount,
      sourceTargetH3: targetH3,
      sourceTargetScore: target.score,
      reportScore: target.reportScore,
      band: target.band,
      reasons: target.reasons,
      commodities: target.commodities,
      scoredForCommodity: target.scoredForCommodity,
      evidenceCaveat: EVIDENCE_CAVEAT,
    };
    return json(response, 201);
  } catch (err) {
    return errorResponse(err);
  }
}
