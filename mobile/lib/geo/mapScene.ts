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
  /**
   * Where a label for this unit belongs, and how much room it has.
   *
   * The anchor is the centre of the largest ring's bounding box and `spanM` is
   * that box's short side, so the map can decline to write a name across a unit
   * too small to hold it rather than stacking illegible text. Both are geometry,
   * not new geological information.
   */
  labelAt: { lng: number; lat: number } | null;
  labelSpanM: number;
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
  /** Steepness in degrees, straight from the pack's DEM derivatives. */
  slopeDeg: number;
  /** Downslope direction, degrees from north. Null where the DEM cell is flat. */
  aspectDeg: number | null;
  morphology: string;
  /** Metres to the nearest mapped drainage, when the pack carries drainage. */
  drainageDistM: number | null;
}

export interface MapScene {
  /** The area the scene was selected for. Panning beyond it needs a rebuild. */
  bbox: [number, number, number, number];
  centre: { lat: number; lng: number };
  polygons: ScenePolygon[];
  /**
   * Land, as mapped coastline polygons.
   *
   * Drawn beneath everything so unmapped ground and open sea stop looking
   * identical. It answers one question — land or water — and it is the pack's
   * own coastline layer, not an inference from where geology happens to stop.
   */
  land: ScenePolygon[];
  faults: SceneLine[];
  otherLines: SceneLine[];
  /** `otherLines`, split by what they represent, so each can be its own layer. */
  contacts: SceneLine[];
  drainage: SceneLine[];
  lineaments: SceneLine[];
  occurrences: ScenePoint[];
  terrain: SceneTerrain[];
  /** Relief range across the scene, so a legend can state what the shading means. */
  elevationRange: { minM: number; maxM: number } | null;
  /** Steepest slope in the scene, so the slope layer can scale its own ramp. */
  maxSlopeDeg: number;
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

/**
 * Vertices kept per COASTLINE ring — effectively all of them.
 *
 * The budget above is a drawing budget, and it was applied to the coastline too.
 * That was wrong, and it was measured: over the Horn of Africa ring the pack
 * carries 843 vertices, `thin()` kept 282 of them, and the shoreline it drew at
 * Boosaaso sat 1.76 km from the town where the pack's own geometry puts it at
 * 0.61 km. At the zoom a geologist walks a traverse at, 1.15 km of invented
 * displacement is over 400 px — the town appeared inland, and the app had put it
 * there.
 *
 * The coastline is the one layer where the boundary IS the measurement. A
 * geology contact may be smoothed; a shoreline may not, because "which side of
 * this line am I on" is the question being asked of it.
 *
 * Nor does it cost anything. The layer holds two polygons, not the hundreds
 * Macrostrat ships, and the map surface already strides vertices at DRAW time
 * against the feature's size on screen (`strideFor`, ExplorationMap.tsx) — so
 * per-frame cost is bounded by pixels, not by how much truth is in the ring.
 * The ceiling stays only so that a future high-resolution pack cannot hand the
 * bridge an unbounded payload.
 */
export const MAX_COASTLINE_VERTICES = 20_000;

/**
 * DEM cells carried for DRAWING at any one time.
 *
 * The pack's grid runs to thousands of cells across the region. A scene covering
 * the whole of it would ship every one of them to the map surface, where at that
 * zoom each is a fraction of a pixel. Measurements never come from here.
 */
export const MAX_TERRAIN_CELLS = 2_500;

/**
 * How many mapped lines of one kind a scene may carry.
 *
 * MEASURED, after shipping the mistake. The derived drainage network is 16,870
 * reaches, and with no cap the scene at a 400 km view was 8.99 MB — thirteen
 * times what it had been — serialised and pushed across the bridge into the
 * WebView on every rebuild. On the device that pegged the JS thread at 100% and
 * drove memory to 1.3 GB.
 *
 * It also bought nothing: sixteen thousand channels at that scale render as a
 * grey wash. A map that cannot show a line usefully should not be sent it.
 */
export const MAX_LINES_PER_KIND = 500;

/**
 * Keep the biggest features when there are too many to draw.
 *
 * Ranked by total vertex count, which for a traced channel network is a proxy for
 * stream order: the trunk wadis survive a zoomed-out view and the rills drop out,
 * which is what a geologist reading a regional map wants. Thinning at random, or
 * by array order, would leave a scatter of disconnected fragments.
 */
function largestFirst(lines: SceneLine[], max: number): SceneLine[] {
  if (lines.length <= max) return lines;
  return [...lines]
    .sort((a, b) =>
      b.paths.reduce((n, p) => n + p.length, 0) - a.paths.reduce((n, p) => n + p.length, 0))
    .slice(0, max);
}

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
    polygons.push(scenePolygon(g, "#3A3A3E"));
  }

  // Coastline, when the pack carries it. Optional by contract: a pack built
  // before the layer existed is still a valid pack, and the map draws whatever
  // it is given.
  const land: ScenePolygon[] = [];
  for (const l of data.land ?? []) {
    if (!l.isPolygon || l.rings.length === 0) continue;
    if (!overlaps(l.bbox, bbox)) continue;
    land.push(scenePolygon(l, LAND_COLOR, MAX_COASTLINE_VERTICES));
  }

  const faults: SceneLine[] = [];
  const otherLines: SceneLine[] = [];
  const contacts: SceneLine[] = [];
  const drainage: SceneLine[] = [];
  const lineaments: SceneLine[] = [];
  for (const f of data.mapFeatures) {
    if (!overlaps(f.bbox, bbox)) continue;
    const line: SceneLine = {
      id: f.id,
      kind: f.kind,
      name: f.name ?? null,
      paths: f.lines.map((l) => thin(l as Array<[number, number]>, MAX_RING_VERTICES)),
    };
    if (f.kind === "fault") faults.push(line);
    else {
      otherLines.push(line);
      if (f.kind === "contact") contacts.push(line);
      else if (f.kind === "drainage") drainage.push(line);
      else if (f.kind === "lineament") lineaments.push(line);
    }
  }

  // Capped per kind, biggest first. Without this the drainage layer alone put
  // 9 MB across the bridge on every scene rebuild.
  const cappedDrainage = largestFirst(drainage, MAX_LINES_PER_KIND);
  const cappedFaults = largestFirst(faults, MAX_LINES_PER_KIND);
  const cappedLineaments = largestFirst(lineaments, MAX_LINES_PER_KIND);
  const cappedContacts = largestFirst(contacts, MAX_LINES_PER_KIND);
  const cappedOther = largestFirst(otherLines, MAX_LINES_PER_KIND);

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

  const inBox = data.terrain.filter(
    (t) => t.lng >= bbox[0] && t.lng <= bbox[2] && t.lat >= bbox[1] && t.lat <= bbox[3],
  );
  // Now that the scene widens with the view, a zoomed-out one can select the
  // pack's entire DEM grid — and at that zoom every cell is smaller than a pixel,
  // so drawing all of them buys nothing and costs a large payload. Thinning is
  // uniform, like MAX_RING_VERTICES, and it affects DRAWING ONLY: elevation,
  // slope and drainage answers are still measured against the full grid.
  const cells = thin(inBox, MAX_TERRAIN_CELLS);
  const elevations = cells.map((t) => t.elevationM);
  const lo = elevations.length ? Math.min(...elevations) : 0;
  const hi = elevations.length ? Math.max(...elevations) : 0;
  const span = hi - lo;
  const terrain: SceneTerrain[] = cells.map((t) => ({
    lng: t.lng,
    lat: t.lat,
    elevationM: t.elevationM,
    // Flat ground has no relief to show; shading it would invent one. Rounded
    // because this is a shading fraction crossing a bridge, not a measurement —
    // seventeen digits of it is payload, and the map cannot draw the difference.
    shade: span > 1 ? Math.round(((t.elevationM - lo) / span) * 1000) / 1000 : 0.5,
    slopeDeg: t.slopeDeg,
    aspectDeg: t.aspectDeg,
    morphology: t.morphology,
    drainageDistM: t.drainageDistM,
  }));

  return {
    bbox,
    centre,
    polygons,
    land,
    faults: cappedFaults,
    otherLines: cappedOther,
    contacts: cappedContacts,
    drainage: cappedDrainage,
    lineaments: cappedLineaments,
    occurrences,
    terrain,
    elevationRange: elevations.length ? { minM: lo, maxM: hi } : null,
    maxSlopeDeg: cells.reduce((m, t) => Math.max(m, t.slopeDeg ?? 0), 0),
  };
}

/** Neutral land fill. Not a geological statement — just "this is not sea". */
const LAND_COLOR = "#1C1D20";

/** One pack polygon, thinned for drawing and given somewhere to put its name. */
function scenePolygon(
  g: { id: string; name: string; attributes: Record<string, unknown> | null; rings: unknown[][] },
  fallbackColor: string,
  // Geology's drawing budget by default; the coastline asks for its own.
  maxVertices: number = MAX_RING_VERTICES,
): ScenePolygon {
  const rings = (g.rings as Array<Array<[number, number]>>).map((r) => thin(r, maxVertices));
  let widest: Array<[number, number]> | null = null;
  let widestSpan = -1;
  let labelAt: { lng: number; lat: number } | null = null;
  for (const r of rings) {
    if (r.length === 0) continue;
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    for (const [lng, lat] of r) {
      if (lng < w) w = lng;
      if (lng > e) e = lng;
      if (lat < s) s = lat;
      if (lat > n) n = lat;
    }
    const span = Math.min((e - w) * M_PER_DEG_LAT * Math.cos((((n + s) / 2) * Math.PI) / 180), (n - s) * M_PER_DEG_LAT);
    if (span > widestSpan) {
      widestSpan = span;
      widest = r;
      labelAt = { lng: (w + e) / 2, lat: (n + s) / 2 };
    }
  }
  return {
    id: g.id,
    name: g.name,
    color: typeof g.attributes?.color === "string" ? g.attributes.color : fallbackColor,
    rings,
    labelAt: widest ? labelAt : null,
    labelSpanM: Math.round(Math.max(0, widestSpan)),
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
