// What is under the finger.
//
// The map was a picture: coloured polygons that could be looked at and not
// asked. A geologist standing on a contact wants to know WHICH units, how old,
// what lithology, from whose map — and the app already held every one of those
// answers in the pack it was drawing from. This module turns a tapped
// coordinate into those answers.
//
// EVERY FIELD IS A LOOKUP. Nothing here computes geology, estimates an age or
// assigns a confidence. A unit's age is the age Macrostrat recorded; an
// occurrence's commodity is the commodity MRDS recorded; where a pack row has
// no value, the field is null and the screen says so. The one derived statement
// is the association line, and it is derived from the pack's OWN association
// table with the weight it carries — see `associatedCommodities`.
import { haversineM, bearingDeg, pointToPolylineM } from "../../../shared/geo-core/geo/spatial.ts";
import { terrainIndexFor } from "./terrainIndex";
import { closestPointOn } from "./orientation";
import type {
  PackData, PackGeologyUnit, PackMapFeature, PackOccurrence, PackTerrainCell,
} from "../../../shared/geo-core/pack/types.ts";

export interface IdentifiedUnit {
  kind: "unit";
  id: string;
  name: string;
  /** Macrostrat's own class for the unit — "metamorphic", "sedimentary", … */
  unitKind: string;
  source: string | null;
  /** Named chronostratigraphic interval, e.g. "Neoproterozoic". */
  interval: string | null;
  ageTopMa: number | null;
  ageBottomMa: number | null;
  lithology: string | null;
  description: string | null;
  color: string | null;
  /** Commodities the pack's association table links to this lithology. */
  associated: AssociatedCommodity[];
}

export interface IdentifiedOccurrence {
  kind: "occurrence";
  id: string;
  name: string | null;
  commodity: string | null;
  depositType: string | null;
  hostRocks: string[] | null;
  source: string;
  reference: string | null;
  lat: number;
  lng: number;
  /** How far the tap landed from the record, so a near miss is not a claim. */
  offsetM: number;
}

export interface IdentifiedLine {
  kind: "line";
  id: string;
  lineKind: string;
  name: string | null;
  source: string | null;
  /** The point on the line nearest the tap — where "go here" actually means. */
  lat: number;
  lng: number;
  offsetM: number;
}

export interface IdentifiedTerrain {
  kind: "terrain";
  elevationM: number;
  slopeDeg: number;
  aspectDeg: number | null;
  morphology: string;
  drainageDistM: number | null;
  /** Distance to the DEM cell this came from. A far cell describes other ground. */
  fromM: number;
}

export type IdentifiedFeature =
  | IdentifiedUnit
  | IdentifiedOccurrence
  | IdentifiedLine
  | IdentifiedTerrain;

export interface AssociatedCommodity {
  commodity: string;
  /** The pack's own weight for the association, 0..1. Null when unweighted. */
  weight: number | null;
}

export interface Identification {
  /** The exact point asked about. */
  at: { lat: number; lng: number };
  features: IdentifiedFeature[];
}

/**
 * How close a tap must land to count as hitting a point or a line.
 *
 * Expressed in metres and supplied by the caller from the map's own
 * metres-per-pixel, so the tolerance is a constant number of PIXELS at any zoom
 * — about a fingertip. A fixed metre tolerance would make occurrences
 * untappable when zoomed out and grab the wrong one when zoomed in.
 */
export const DEFAULT_TAP_RADIUS_M = 60;

/** Past this a DEM cell is describing different ground and is not reported. */
export const TERRAIN_MAX_M = 5_000;

/** Point in polygon, with holes — even-odd over every ring of the unit. */
export function pointInRings(
  rings: ReadonlyArray<ReadonlyArray<readonly [number, number]>>,
  at: { lat: number; lng: number },
): boolean {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1];
      const xj = ring[j][0], yj = ring[j][1];
      const crosses = yi > at.lat !== yj > at.lat;
      if (!crosses) continue;
      const x = xi + ((at.lat - yi) / (yj - yi)) * (xj - xi);
      if (at.lng < x) inside = !inside;
    }
  }
  return inside;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);

/** The unit a point falls inside, if any. Bbox rejection first, then exact. */
export function unitAt(data: PackData, at: { lat: number; lng: number }): PackGeologyUnit | null {
  for (const g of data.geology) {
    if (!g.isPolygon) continue;
    const [w, s, e, n] = g.bbox;
    if (at.lng < w || at.lng > e || at.lat < s || at.lat > n) continue;
    if (pointInRings(g.rings, at)) return g;
  }
  return null;
}

/**
 * Commodities the pack associates with a lithology.
 *
 * Read straight out of `data.associations`, which is a pack table with its own
 * weights — the same table the confidence engine uses. It is an association,
 * stated as one; it is not a prediction that this ground contains anything.
 */
export function associatedCommodities(data: PackData, hostRock: string | null): AssociatedCommodity[] {
  if (!hostRock) return [];
  const key = hostRock.toLowerCase();
  return data.associations
    .filter((a) => a.host_rock_code?.toLowerCase() === key)
    .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))
    .slice(0, 4)
    .map((a) => ({ commodity: a.commodity_code, weight: a.weight ?? null }));
}

function describeUnit(data: PackData, g: PackGeologyUnit): IdentifiedUnit {
  const a = g.attributes ?? {};
  const lithology = str(a.lith);
  return {
    kind: "unit",
    id: g.id,
    name: g.name,
    unitKind: g.kind,
    source: g.source,
    interval: str(a.interval),
    ageTopMa: num(a.age_top_ma),
    ageBottomMa: num(a.age_bottom_ma),
    lithology,
    description: str(a.descrip),
    color: str(a.color),
    associated: associatedCommodities(data, lithology),
  };
}

function describeOccurrence(o: PackOccurrence, offsetM: number): IdentifiedOccurrence {
  return {
    kind: "occurrence",
    id: o.id,
    name: o.name,
    commodity: o.commodity_key,
    depositType: o.deposit_type,
    hostRocks: o.host_rocks,
    source: o.source,
    reference: o.reference,
    lat: o.lat,
    lng: o.lng,
    offsetM,
  };
}

/**
 * Where on a mapped line to actually go.
 *
 * The nearest POINT on the line, not the nearest vertex. Those are not the same
 * place and the difference is not academic: mapped faults in this pack have
 * vertices kilometres apart, so navigating to the nearest vertex can send a
 * geologist a long way down the trace from the stretch they are standing beside.
 * `closestPointOn` projects onto the segments, and it is the same function
 * `orientation` already uses to name a fault's direction — so the sheet, the
 * guidance and the navigation cannot disagree about where a fault is.
 *
 * The DISTANCE still comes from the shared `pointToPolylineM`, which is what
 * targeting measures with. One measure, one answer.
 */
function nearestPointOnFeature(
  f: PackMapFeature,
  at: { lat: number; lng: number },
): { lat: number; lng: number; distanceM: number } | null {
  let best: { lat: number; lng: number; distanceM: number } | null = null;
  for (const line of f.lines) {
    const d = pointToPolylineM(at, line);
    if (best && d >= best.distanceM) continue;
    const point = closestPointOn(at, line);
    if (point) best = { ...point, distanceM: d };
  }
  return best;
}

/**
 * The nearest mapped line of one kind — a contact, a drainage, a lineament.
 *
 * `orientation` already answers this for faults, which are the kind targeting
 * cares about. The other kinds matter to the geologist standing there: a contact
 * 200 m away is where two rocks meet, and that is where to look.
 */
export function nearestLineOfKind(
  data: PackData,
  at: { lat: number; lng: number },
  kind: string,
): { distanceM: number; bearingDeg: number; name: string | null } | null {
  let best: { distanceM: number; bearingDeg: number; name: string | null } | null = null;
  for (const f of data.mapFeatures) {
    if (f.kind !== kind) continue;
    const p = nearestPointOnFeature(f, at);
    if (!p) continue;
    if (best && p.distanceM >= best.distanceM) continue;
    best = { distanceM: p.distanceM, bearingDeg: bearingDeg(at, p), name: f.name ?? null };
  }
  return best;
}

/**
 * The DEM cell nearest a point, when one is close enough to describe it.
 *
 * Indexed by H3 cell, not scanned. The occurrence-biased pack held 2,191 terrain
 * rows and a linear scan here went unnoticed; the independent Copernicus grid is
 * 254,623, and this is called once per candidate cell on every recompute. That is
 * the same shape as the bug that froze the app: invisible at small N, fatal at
 * large N, on the thread that answers buttons.
 */
export function terrainAt(
  data: PackData,
  at: { lat: number; lng: number },
  maxM = TERRAIN_MAX_M,
): (PackTerrainCell & { fromM: number }) | null {
  return terrainIndexFor(data.terrain).nearest(at.lat, at.lng, maxM);
}

/**
 * Everything the pack can say about one tapped point, most specific first.
 *
 * Order is deliberate: a point record is a stronger answer than the polygon it
 * sits in, and the polygon is a stronger answer than the DEM cell nearest it.
 * The screen shows the first as the headline and the rest as context, so one
 * tap on a mineral occurrence inside a mapped unit on a slope produces one
 * coherent answer rather than three competing ones.
 */
export function identifyAt(
  data: PackData,
  at: { lat: number; lng: number },
  opts: { tapRadiusM?: number } = {},
): Identification {
  const radius = opts.tapRadiusM ?? DEFAULT_TAP_RADIUS_M;
  const features: IdentifiedFeature[] = [];

  let nearestOcc: { o: PackOccurrence; d: number } | null = null;
  for (const o of data.occurrences) {
    const d = haversineM(at, { lat: o.lat, lng: o.lng });
    if (d > radius) continue;
    if (!nearestOcc || d < nearestOcc.d) nearestOcc = { o, d };
  }
  if (nearestOcc) features.push(describeOccurrence(nearestOcc.o, nearestOcc.d));

  let nearestLine: { f: PackMapFeature; p: { lat: number; lng: number; distanceM: number } } | null = null;
  for (const f of data.mapFeatures) {
    const [w, s, e, n] = f.bbox;
    // Reject on a box grown by the tap radius, in degrees — cheap, and it keeps
    // the polyline maths off every line in the pack.
    const pad = radius / 111_195;
    if (at.lng < w - pad || at.lng > e + pad || at.lat < s - pad || at.lat > n + pad) continue;
    const p = nearestPointOnFeature(f, at);
    if (!p || p.distanceM > radius) continue;
    if (!nearestLine || p.distanceM < nearestLine.p.distanceM) nearestLine = { f, p };
  }
  if (nearestLine) {
    features.push({
      kind: "line",
      id: nearestLine.f.id,
      lineKind: nearestLine.f.kind,
      name: nearestLine.f.name,
      source: nearestLine.f.source,
      lat: nearestLine.p.lat,
      lng: nearestLine.p.lng,
      offsetM: nearestLine.p.distanceM,
    });
  }

  const unit = unitAt(data, at);
  if (unit) features.push(describeUnit(data, unit));

  const cell = terrainAt(data, at);
  if (cell) {
    features.push({
      kind: "terrain",
      elevationM: cell.elevationM,
      slopeDeg: cell.slopeDeg,
      aspectDeg: cell.aspectDeg,
      morphology: cell.morphology,
      drainageDistM: cell.drainageDistM,
      fromM: cell.fromM,
    });
  }

  return { at, features };
}

/** Distance and direction from where the geologist is actually standing. */
export function journeyTo(
  from: { lat: number; lng: number } | null,
  to: { lat: number; lng: number },
): { distanceM: number; bearingDeg: number } | null {
  // Invariant 4: never a bearing from a position nobody is standing at.
  if (!from) return null;
  return { distanceM: haversineM(from, to), bearingDeg: bearingDeg(from, to) };
}
