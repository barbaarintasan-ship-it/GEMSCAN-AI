// The map's data, in geographic coordinates.
//
// Distinct from mapView.ts, which projects a FIXED view to screen pixels for a
// still image. An interactive map cannot work that way: the projection changes
// with every pan, pinch and rotation, so it has to happen where the gestures
// are — inside the map surface, sixty times a second. This module's job is only
// to decide WHAT is on the map and hand it over in lng/lat.
//
// Everything here is selection and thinning. No projection, no styling
// decisions beyond the colours the source data already carries, and nothing
// invented: a feature is in the scene because the pack contains it.
import type { PackData } from "../../../shared/geo-core/pack/types.ts";

export interface ScenePolygon {
  id: string;
  name: string;
  color: string;
  rings: Array<Array<[number, number]>>;
}

export interface SceneLine {
  id: string;
  kind: string;
  name: string | null;
  paths: Array<Array<[number, number]>>;
}

export interface ScenePoint {
  id: string;
  label: string;
  commodity: string | null;
  lng: number;
  lat: number;
}

export interface SceneTerrain {
  lng: number;
  lat: number;
  elevationM: number;
  /** 0..1 within the scene's own relief. Presentation only — never a measurement. */
  shade: number;
}

export interface MapScene {
  /** The area the scene was selected for. Panning beyond it needs a rebuild. */
  bbox: [number, number, number, number];
  centre: { lat: number; lng: number };
  polygons: ScenePolygon[];
  faults: SceneLine[];
  otherLines: SceneLine[];
  occurrences: ScenePoint[];
  terrain: SceneTerrain[];
  /** Relief range across the scene, so a legend can state what the shading means. */
  elevationRange: { minM: number; maxM: number } | null;
}

/**
 * How much ground to prepare, as a multiple of the visible half-width.
 *
 * The scene is built once and then panned and zoomed over, so it has to cover
 * more than the first view or the map would go blank at the edge of a drag.
 * Four times the initial radius is roughly two zoom-outs and a long pan in any
 * direction before a rebuild is needed.
 */
export const SCENE_MARGIN = 4;

const M_PER_DEG_LAT = 111_195;

/**
 * Vertices kept per ring.
 *
 * The real Macrostrat units run to thousands of vertices each, and a phone
 * redrawing several of those on every touch-move frame will not hold sixty
 * frames a second. Thinning is uniform (every nth vertex, endpoints always
 * kept) rather than distance-based, so a coastline stays a coastline and a
 * boundary never gains a spike it did not have.
 *
 * This affects DRAWING ONLY. Every measurement — which unit you are standing
 * in, how far the fault is — is computed elsewhere against the full geometry.
 */
export const MAX_RING_VERTICES = 400;

function thin<T>(ring: T[], max: number): T[] {
  if (ring.length <= max) return ring;
  const step = Math.ceil(ring.length / max);
  const out: T[] = [];
  for (let i = 0; i < ring.length; i += step) out.push(ring[i]);
  const last = ring[ring.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

const overlaps = (
  b: readonly [number, number, number, number],
  box: readonly [number, number, number, number],
) => !(b[2] < box[0] || b[0] > box[2] || b[3] < box[1] || b[1] > box[3]);

/**
 * Select everything the pack has around a point.
 *
 * `radiusM` is the half-width of the INITIAL view; the scene itself is built
 * `SCENE_MARGIN` times larger so panning and zooming out stay smooth.
 */
export function buildScene(
  data: PackData,
  centre: { lat: number; lng: number },
  radiusM: number,
): MapScene {
  const spanM = radiusM * SCENE_MARGIN;
  const dLat = spanM / M_PER_DEG_LAT;
  const cosLat = Math.max(0.1, Math.cos((centre.lat * Math.PI) / 180));
  const dLng = dLat / cosLat;

  const bbox: [number, number, number, number] = [
    centre.lng - dLng, centre.lat - dLat, centre.lng + dLng, centre.lat + dLat,
  ];

  const polygons: ScenePolygon[] = [];
  for (const g of data.geology) {
    if (!g.isPolygon || g.rings.length === 0) continue;
    // Overlap, not containment: a unit far larger than the view still colours
    // it, and requiring containment would leave the map blank on exactly the
    // regional units that cover most ground.
    if (!overlaps(g.bbox, bbox)) continue;
    polygons.push({
      id: g.id,
      name: g.name,
      color: typeof g.attributes?.color === "string" ? g.attributes.color : "#3A3A3E",
      rings: g.rings.map((r) => thin(r as Array<[number, number]>, MAX_RING_VERTICES)),
    });
  }

  const faults: SceneLine[] = [];
  const otherLines: SceneLine[] = [];
  for (const f of data.mapFeatures) {
    if (!overlaps(f.bbox, bbox)) continue;
    const line: SceneLine = {
      id: f.id,
      kind: f.kind,
      name: f.name ?? null,
      paths: f.lines.map((l) => thin(l as Array<[number, number]>, MAX_RING_VERTICES)),
    };
    (f.kind === "fault" ? faults : otherLines).push(line);
  }

  const occurrences: ScenePoint[] = [];
  for (const o of data.occurrences) {
    if (o.lng < bbox[0] || o.lng > bbox[2] || o.lat < bbox[1] || o.lat > bbox[3]) continue;
    occurrences.push({
      id: o.id,
      label: o.name ?? o.commodity_key ?? "occurrence",
      commodity: o.commodity_key,
      lng: o.lng,
      lat: o.lat,
    });
  }

  const cells = data.terrain.filter(
    (t) => t.lng >= bbox[0] && t.lng <= bbox[2] && t.lat >= bbox[1] && t.lat <= bbox[3],
  );
  const elevations = cells.map((t) => t.elevationM);
  const lo = elevations.length ? Math.min(...elevations) : 0;
  const hi = elevations.length ? Math.max(...elevations) : 0;
  const span = hi - lo;
  const terrain: SceneTerrain[] = cells.map((t) => ({
    lng: t.lng,
    lat: t.lat,
    elevationM: t.elevationM,
    // Flat ground has no relief to show; shading it would invent one.
    shade: span > 1 ? (t.elevationM - lo) / span : 0.5,
  }));

  return {
    bbox,
    centre,
    polygons,
    faults,
    otherLines,
    occurrences,
    terrain,
    elevationRange: elevations.length ? { minM: lo, maxM: hi } : null,
  };
}

/**
 * Whether a scene still covers a point comfortably.
 *
 * Rebuilding on every fix would throw away the map surface mid-gesture, so the
 * scene is kept until the viewer approaches its edge. The margin is half the
 * scene, which means a rebuild happens well before anything runs out.
 */
export function sceneCovers(scene: MapScene, at: { lat: number; lng: number }): boolean {
  const [w, s, e, n] = scene.bbox;
  const padLng = (e - w) * 0.25;
  const padLat = (n - s) * 0.25;
  return (
    at.lng >= w + padLng && at.lng <= e - padLng &&
    at.lat >= s + padLat && at.lat <= n - padLat
  );
}
