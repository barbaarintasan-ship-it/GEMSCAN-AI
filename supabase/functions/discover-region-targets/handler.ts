// discover-region-targets — Issue 1 (2026-09-24 audit): TRUE Phase 15
// region-wide discovery.
//
//   manager-drawn polygon
//       -> H3 cells inside polygon (fillMultiPolygon, same pure function
//          generate-mission-cells already uses)
//       -> each cell scored by the SAME deterministic TargetingEngine every
//          other targeting path uses (targetAt(), unmodified, unreplaced)
//       -> low-value cells filtered by score
//       -> survivors grouped into candidate areas by PURE SPATIAL adjacency
//          (regionDiscovery.ts's clusterAdjacentCells) — no AI, no
//          geological-similarity clustering, no new prospectivity formula
//
// team-targeting's point+kRing path (Phase 15 as originally shipped) is a
// SEPARATE function, untouched by this one.
//
// COST CONTROL: the polygon is filled first; if the resulting cell count
// exceeds MAX_POLYGON_CELLS the request is REJECTED with a clear message —
// never silently truncated and presented as a complete scan. Per-cell
// GeoContext fetches run with bounded concurrency (mapWithConcurrency)
// rather than TargetingEngine.rank()'s fully sequential loop, but each
// fetch is still one real query — MAX_POLYGON_CELLS mirrors score-mission-
// cells' own MAX_CELLS_PER_SCORING_CALL (200) exactly, the same accepted
// order of magnitude already live in production for k-ring scans.
//
// AUTHORIZATION: is_mission_manager — this is a cost-bearing planning scan
// (up to 200 cells x up to 7 provider queries each), the same tier as
// create_manual_mission_area/score-mission-cells' own RPC boundary, not a
// passive is_mission_member read.
import { corsHeaders } from "../_shared/cors.ts";
import { BadRequestError, errorResponse, ForbiddenError, json } from "../_shared/enterprise/errors.ts";
import { resolveActor as realResolveActor, type Actor } from "../_shared/enterprise/auth.ts";
import { serviceClient, userClient } from "../_shared/enterprise/clients.ts";
import { makeServerGeoContext } from "../_shared/geocontext/serverGeoContext.ts";
import { cellFor, cellCentre, cellBoundaryRing } from "../_shared/geocontext/h3.ts";
import { fetchStructuralMapFeatures, packWithMapFeatures } from "../_shared/geocontext/structuralPack.ts";
import { H3_RESOLUTION } from "../../../shared/geo-core/geo/h3.ts";
import { fillMultiPolygon, InvalidAreaGeometryError } from "../generate-mission-cells/h3fill.ts";
import { TargetingEngine, type H3Ops, type ExplorationTarget } from "../../../shared/geo-core/gie/targetingEngine.ts";
import { normalizePolygonToMultiPolygon, clusterAdjacentCells, InvalidPolygonInputError } from "./regionDiscovery.ts";

export const MAX_POLYGON_CELLS = 200;
export const DEFAULT_MIN_SCORE = 0.05;
const DEFAULT_RADIUS_M = 10_000;
const STRUCTURAL_MARGIN_M = 3_000;
const SCORING_CONCURRENCY = 8;

// TargetingEngine.targetAt() round-trips the queried point through
// h3.cellFor() internally (to attach the correct cell id to its result) —
// that path genuinely needs the real function. kRing is NOT used by
// targetAt() (only rank()'s k-ring sweep uses it, which this handler never
// calls) — stubbed to fail loudly if that assumption is ever wrong, rather
// than silently expanding a point the way Issue 1 explicitly forbids.
const H3_OPS: H3Ops = {
  cellFor,
  cellCentre,
  kRing: () => { throw new Error("kRing must never run in polygon discovery — the polygon is the authoritative boundary, not a k-ring expansion"); },
};

function haversineM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6_371_008.8;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const la1 = toRad(a.lat);
  const la2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export interface ClusterResponse {
  clusterId: string;
  memberCells: string[];
  cellCount: number;
  score: number;
  reportScore: number;
  band: string;
  commodities: string[];
  scoredForCommodity: string | null;
  reasons: unknown[];
  coverage: unknown;
  center: { lat: number; lng: number };
  geometry: { type: "MultiPolygon"; coordinates: number[][][][] };
}

export interface DiscoverRegionResponse {
  resolution: number;
  totalCellsInPolygon: number;
  scoredCells: number;
  filteredOutCells: number;
  minScore: number;
  clusters: ClusterResponse[];
  evidenceCaveat: string;
}

export interface RegionDiscoveryDeps {
  resolveActor: (req: Request) => Promise<Actor>;
  isMissionManager: (req: Request, missionId: string) => Promise<boolean>;
  buildEngine: (lat: number, lng: number, radiusM: number) => Promise<TargetingEngine>;
}

export const defaultDeps: RegionDiscoveryDeps = {
  resolveActor: realResolveActor,
  isMissionManager: async (req, missionId) => {
    const { data, error } = await userClient(req).rpc("is_mission_manager", { p_mission: missionId });
    if (error) return false;
    return data === true;
  },
  buildEngine: async (lat, lng, radiusM) => {
    const svc = serviceClient();
    const geo = makeServerGeoContext(svc);
    const mapFeatures = await fetchStructuralMapFeatures(svc, lat, lng, radiusM);
    return new TargetingEngine(geo, H3_OPS, undefined, () => packWithMapFeatures(mapFeatures));
  },
};

const EVIDENCE_CAVEAT =
  "Same evidence coverage as point-based team targeting: occurrence, association, community, geology-unit and " +
  "structural (fault) evidence are included; contact, lithology-prior and terrain-prior evidence are not yet " +
  "available server-side. Cluster score/reasons are the representative (highest-scoring) member cell's own " +
  "TargetingEngine output — nothing here is a new or averaged formula.";

function num(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : (v as number);
  return Number.isFinite(n) ? n : null;
}

export async function handleDiscoverRegionTargets(req: Request, deps: RegionDiscoveryDeps = defaultDeps): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    await deps.resolveActor(req);

    let body: Record<string, unknown> = {};
    if (req.method === "POST") body = await req.json().catch(() => ({}));
    const missionId = String(body.missionId ?? "");
    if (!missionId) throw new BadRequestError("missionId is required");
    if (!body.polygon) throw new BadRequestError("polygon is required");

    if (!(await deps.isMissionManager(req, missionId))) {
      throw new ForbiddenError("only a mission manager can run a region-wide scan (cost-bearing — same tier as creating an area)");
    }

    const commodity = (body.commodity ?? null) as string | null;
    const minScore = num(body.minScore) ?? DEFAULT_MIN_SCORE;
    const radiusM = num(body.radiusM) ?? DEFAULT_RADIUS_M;

    const normalized = normalizePolygonToMultiPolygon(body.polygon);
    const cells = fillMultiPolygon(normalized, H3_RESOLUTION);

    if (cells.length > MAX_POLYGON_CELLS) {
      throw new BadRequestError(
        `this polygon covers ${cells.length} H3 cells, above the supported limit of ${MAX_POLYGON_CELLS} per scan — ` +
        `draw a smaller area or split it into multiple scans. The request was rejected, not truncated.`,
      );
    }

    const centres = cells.map((cell) => ({ cell, centre: cellCentre(cell) }));
    const centroid = {
      lat: centres.reduce((s, c) => s + c.centre.lat, 0) / centres.length,
      lng: centres.reduce((s, c) => s + c.centre.lng, 0) / centres.length,
    };
    const structuralRadiusM = Math.max(...centres.map((c) => haversineM(centroid, c.centre))) + STRUCTURAL_MARGIN_M;

    const engine = await deps.buildEngine(centroid.lat, centroid.lng, structuralRadiusM);

    const built = await mapWithConcurrency(centres, SCORING_CONCURRENCY, ({ cell, centre }) =>
      engine.targetAt(centroid, centre, { commodity, radiusM }).then((t) => ({ cell, target: t })));

    const byCell = new Map<string, ExplorationTarget>();
    for (const { cell, target } of built) if (target) byCell.set(cell, target);

    const survivorIds = Array.from(byCell.entries())
      .filter(([, t]) => t.score >= minScore)
      .map(([cell]) => cell);

    const clusterGroups = clusterAdjacentCells(survivorIds);

    const clusters: ClusterResponse[] = clusterGroups.map((memberCells, i) => {
      const members = memberCells.map((cell) => byCell.get(cell)!);
      const representative = members.reduce((best, t) => (t.score > best.score ? t : best), members[0]);
      const centreLat = members.reduce((s, t) => s + t.centre.lat, 0) / members.length;
      const centreLng = members.reduce((s, t) => s + t.centre.lng, 0) / members.length;
      return {
        clusterId: `cluster-${i}`,
        memberCells,
        cellCount: memberCells.length,
        score: representative.score,
        reportScore: representative.reportScore,
        band: representative.band,
        commodities: representative.commodities,
        scoredForCommodity: representative.scoredForCommodity,
        reasons: representative.reasons,
        coverage: representative.coverage,
        center: { lat: centreLat, lng: centreLng },
        // cellBoundaryRing already returns GeoJSON-ordered [lng, lat] pairs,
        // closed ring (see geocontext/h3.ts: cellToBoundary(cell, true)) —
        // no reordering needed here.
        geometry: {
          type: "MultiPolygon" as const,
          coordinates: memberCells.map((cell) => [cellBoundaryRing(cell) as unknown as number[][]]),
        },
      };
    }).sort((a, b) => b.score - a.score);

    const response: DiscoverRegionResponse = {
      resolution: H3_RESOLUTION,
      totalCellsInPolygon: cells.length,
      scoredCells: byCell.size,
      filteredOutCells: byCell.size - survivorIds.length,
      minScore,
      clusters,
      evidenceCaveat: EVIDENCE_CAVEAT,
    };
    return json(response);
  } catch (err) {
    if (err instanceof InvalidAreaGeometryError || err instanceof InvalidPolygonInputError) {
      return json({ error: err.message, code: "invalid_area_geometry" }, 422);
    }
    return errorResponse(err);
  }
}
