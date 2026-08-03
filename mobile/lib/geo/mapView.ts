// Offline geological map — pure extraction and projection.
//
// Everything drawn comes from the knowledge pack already on the device: no
// tiles, no basemap, no network. That is not a limitation to work around, it is
// the point — the map has to work in the same places the guidance does.
//
// This module does the geometry and hands back plain shapes; rendering lives in
// components/GeologyMap.tsx. Keeping them apart means the projection is
// unit-testable without a WebView.
import { haversineM, pointToPolylineM } from "../../../shared/geo-core/geo/spatial.ts";
import type { PackData } from "../../../shared/geo-core/pack/types.ts";

export interface MapPolygon {
  id: string;
  name: string;
  color: string;
  /** Screen-space rings, already projected. */
  rings: Array<Array<[number, number]>>;
}

export interface MapLine {
  id: string;
  kind: string;
  paths: Array<Array<[number, number]>>;
}

export interface MapPoint {
  id: string;
  label: string;
  commodity: string | null;
  x: number;
  y: number;
  distanceM: number;
}

export interface MapTerrainDot {
  x: number;
  y: number;
  /** 0..1, normalised elevation within the view — drives the shading only. */
  shade: number;
  elevationM: number;
}

export interface MapView {
  width: number;
  height: number;
  /** Geographic extent actually drawn. */
  bbox: [number, number, number, number];
  polygons: MapPolygon[];
  lines: MapLine[];
  points: MapPoint[];
  terrain: MapTerrainDot[];
  /** The viewer's own position, or the place being looked up. */
  centre: { x: number; y: number };
  /** Where the recommendation points, when there is one. */
  target: { x: number; y: number; bearingDeg: number; distanceM: number } | null;
  scaleBar: { km: number; px: number };
}

/** Default half-width of the view. 12 km shows a walkable neighbourhood. */
export const DEFAULT_VIEW_RADIUS_M = 12_000;

const M_PER_DEG_LAT = 111_195;

/**
 * Builds a view centred on a point.
 *
 * Longitude is scaled by cos(lat) so the map is not stretched east-west — at
 * Somalia's latitudes the difference is small but visible, and a map that
 * distorts direction is worse than no map when someone is using it to walk.
 */
export function buildMapView(
  data: PackData,
  centre: { lat: number; lng: number },
  opts: {
    width: number;
    height: number;
    radiusM?: number;
    target?: { lat: number; lng: number; bearingDeg: number; distanceM: number } | null;
  },
): MapView {
  const radiusM = opts.radiusM ?? DEFAULT_VIEW_RADIUS_M;
  const { width, height } = opts;

  const dLat = radiusM / M_PER_DEG_LAT;
  const cosLat = Math.max(0.1, Math.cos((centre.lat * Math.PI) / 180));
  const dLng = dLat / cosLat;

  const bbox: [number, number, number, number] = [
    centre.lng - dLng, centre.lat - dLat, centre.lng + dLng, centre.lat + dLat,
  ];

  const project = (lng: number, lat: number): [number, number] => [
    ((lng - bbox[0]) / (bbox[2] - bbox[0])) * width,
    // SVG y grows downward; north must be up.
    height - ((lat - bbox[1]) / (bbox[3] - bbox[1])) * height,
  ];

  const inView = (lng: number, lat: number) =>
    lng >= bbox[0] && lng <= bbox[2] && lat >= bbox[1] && lat <= bbox[3];

  // ── Bedrock ───────────────────────────────────────────────────────────────
  const polygons: MapPolygon[] = [];
  for (const g of data.geology) {
    if (!g.isPolygon || g.rings.length === 0) continue;
    // Reject by bbox overlap, not containment: a unit larger than the view
    // still colours it, and dropping it would leave the map blank on exactly
    // the regional units that matter most.
    if (g.bbox[2] < bbox[0] || g.bbox[0] > bbox[2] || g.bbox[3] < bbox[1] || g.bbox[1] > bbox[3]) continue;
    const colour = typeof g.attributes?.color === "string" ? g.attributes.color : "#3A3A3E";
    polygons.push({
      id: g.id,
      name: g.name,
      color: colour,
      rings: g.rings.map((r) => r.map(([lng, lat]) => project(lng, lat))),
    });
  }

  // ── Structure ─────────────────────────────────────────────────────────────
  const lines: MapLine[] = [];
  for (const f of data.mapFeatures) {
    if (f.bbox[2] < bbox[0] || f.bbox[0] > bbox[2] || f.bbox[3] < bbox[1] || f.bbox[1] > bbox[3]) continue;
    lines.push({
      id: f.id,
      kind: f.kind,
      paths: f.lines.map((l) => l.map(([lng, lat]) => project(lng, lat))),
    });
  }

  // ── Known occurrences ─────────────────────────────────────────────────────
  const points: MapPoint[] = [];
  for (const o of data.occurrences) {
    if (!inView(o.lng, o.lat)) continue;
    const [x, y] = project(o.lng, o.lat);
    points.push({
      id: o.id,
      label: o.name ?? o.commodity_key ?? "occurrence",
      commodity: o.commodity_key,
      x, y,
      distanceM: haversineM(centre, { lat: o.lat, lng: o.lng }),
    });
  }

  // ── Terrain shading ───────────────────────────────────────────────────────
  const cells = data.terrain.filter((t) => inView(t.lng, t.lat));
  const elevations = cells.map((t) => t.elevationM);
  const lo = elevations.length ? Math.min(...elevations) : 0;
  const hi = elevations.length ? Math.max(...elevations) : 0;
  const span = hi - lo;
  const terrain: MapTerrainDot[] = cells.map((t) => {
    const [x, y] = project(t.lng, t.lat);
    // A flat neighbourhood has no relief to show; shading it would invent one.
    return { x, y, shade: span > 1 ? (t.elevationM - lo) / span : 0.5, elevationM: t.elevationM };
  });

  const [cx, cy] = project(centre.lng, centre.lat);
  const target = opts.target
    ? (() => {
        const [tx, ty] = project(opts.target!.lng, opts.target!.lat);
        return { x: tx, y: ty, bearingDeg: opts.target!.bearingDeg, distanceM: opts.target!.distanceM };
      })()
    : null;

  // Scale bar: a round number of km that fits comfortably across the view.
  const viewKm = (radiusM * 2) / 1000;
  const km = viewKm >= 20 ? 5 : viewKm >= 8 ? 2 : 1;
  const scaleBar = { km, px: (km / viewKm) * width };

  return { width, height, bbox, polygons, lines, points, terrain, centre: { x: cx, y: cy }, target, scaleBar };
}

/** Nearest mapped fault to a point, for the evidence readout. */
export function nearestFaultM(data: PackData, at: { lat: number; lng: number }): number | null {
  let best = Infinity;
  for (const f of data.mapFeatures) {
    if (f.kind !== "fault") continue;
    for (const l of f.lines) {
      const d = pointToPolylineM(at, l);
      if (d < best) best = d;
    }
  }
  return Number.isFinite(best) ? best : null;
}

/** Nearest known occurrence, for the evidence readout. */
export function nearestOccurrence(
  data: PackData,
  at: { lat: number; lng: number },
): { distanceM: number; commodity: string | null; name: string | null } | null {
  let best: { distanceM: number; commodity: string | null; name: string | null } | null = null;
  for (const o of data.occurrences) {
    const d = haversineM(at, { lat: o.lat, lng: o.lng });
    if (!best || d < best.distanceM) best = { distanceM: d, commodity: o.commodity_key, name: o.name };
  }
  return best;
}

/** Elevation at the nearest terrain cell, or null when no DEM covers the point. */
export function elevationAt(data: PackData, at: { lat: number; lng: number }): number | null {
  let best: number | null = null;
  let bestD = Infinity;
  for (const t of data.terrain) {
    const d = haversineM(at, { lat: t.lat, lng: t.lng });
    if (d < bestD) { bestD = d; best = t.elevationM; }
  }
  // Beyond ~5 km the nearest sampled cell no longer describes this ground.
  return bestD <= 5000 ? best : null;
}
