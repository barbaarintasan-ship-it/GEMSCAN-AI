// Pure geometry/clustering logic for Issue 1 (2026-09-24 audit) — TRUE
// Phase 15 region-wide discovery. No network, no DB, no h3-js side effects
// beyond deterministic pure functions — testable exactly like h3fill.ts.
//
// Two responsibilities, deliberately kept separate per the audit's own
// instruction ("geological score ≠ cluster membership"):
//   1. normalizePolygonToMultiPolygon — GeoJSON Polygon or MultiPolygon in,
//      MultiPolygon out (fillMultiPolygon only accepts MultiPolygon).
//   2. clusterAdjacentCells — PURE SPATIAL clustering (H3 1-ring adjacency,
//      union-find) over an already-filtered list of cell ids. It knows
//      nothing about score, commodity or evidence — the caller decides which
//      cells survive filtering before this ever runs.
import { gridDisk } from "https://esm.sh/h3-js@4.1.0";

export type GeoJsonPolygon = { type: "Polygon"; coordinates: number[][][] };
export type GeoJsonMultiPolygonIn = { type: "MultiPolygon"; coordinates: number[][][][] };

export class InvalidPolygonInputError extends Error {}

/** Cheap bbox-extent area estimate in km², BEFORE the expensive real fill.
 *  Real-world bug (2026-09-24): a polygon spanning ~34° of latitude by
 *  mistake made fillMultiPolygon try to enumerate an astronomical H3 cell
 *  set, which could hang or exhaust the edge function's memory/time budget
 *  long before MAX_POLYGON_CELLS' post-fill check ever runs — surfacing to
 *  the client as a raw connection failure, not a clean 400. This walks
 *  every ring's raw coordinates (no h3-js call) to reject absurd input
 *  fast, without ever attempting the real fill. Bbox area is always ≥ the
 *  true polygon area, so a generous margin over the cell cap's own
 *  representable area avoids false-positives on legitimately large but
 *  irregular polygons.
 */
export function estimateBboxAreaKm2(geojson: GeoJsonMultiPolygonIn): number {
  const KM_PER_DEG_LAT = 111.32;
  let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
  for (const polygon of geojson.coordinates) {
    for (const ring of polygon) {
      for (const [lng, lat] of ring) {
        if (lng < minLng) minLng = lng;
        if (lng > maxLng) maxLng = lng;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
      }
    }
  }
  if (!Number.isFinite(minLng) || !Number.isFinite(minLat)) return 0;
  const midLat = (minLat + maxLat) / 2;
  const kmPerDegLng = KM_PER_DEG_LAT * Math.max(0.01, Math.cos((midLat * Math.PI) / 180));
  const heightKm = Math.max(0, maxLat - minLat) * KM_PER_DEG_LAT;
  const widthKm = Math.max(0, maxLng - minLng) * kmPerDegLng;
  return heightKm * widthKm;
}

/** Polygon → MultiPolygon (wrap once); MultiPolygon passes through unchanged.
 *  Anything else is rejected — this function never guesses. */
export function normalizePolygonToMultiPolygon(
  geojson: unknown,
): GeoJsonMultiPolygonIn {
  const g = geojson as { type?: string; coordinates?: unknown };
  if (!g || typeof g !== "object") throw new InvalidPolygonInputError("polygon is required");
  if (g.type === "MultiPolygon") {
    if (!Array.isArray(g.coordinates)) throw new InvalidPolygonInputError("MultiPolygon coordinates must be an array");
    return { type: "MultiPolygon", coordinates: g.coordinates as number[][][][] };
  }
  if (g.type === "Polygon") {
    if (!Array.isArray(g.coordinates)) throw new InvalidPolygonInputError("Polygon coordinates must be an array");
    return { type: "MultiPolygon", coordinates: [g.coordinates as number[][][]] };
  }
  throw new InvalidPolygonInputError(`polygon must be a GeoJSON Polygon or MultiPolygon, got "${g.type}"`);
}

/**
 * Deterministic connected-components clustering over H3 1-ring adjacency.
 *
 * Two survivor cells are in the same cluster iff there is a PATH of
 * mutually-1-ring-adjacent survivor cells between them — not merely "both
 * scored well," which would conflate geological score with spatial
 * grouping (explicitly disallowed by the audit). No AI, no similarity
 * metric — only whether two hexagons touch.
 *
 * Output groups are sorted (member cell ids ascending within a group, groups
 * ordered by their own first member) so results are stable across runs and
 * directly assertable in tests, exactly like fillMultiPolygon's own
 * dedup+sort discipline.
 */
export function clusterAdjacentCells(survivorCells: readonly string[]): string[][] {
  const survivors = Array.from(new Set(survivorCells));
  const survivorSet = new Set(survivors);
  const parent = new Map<string, string>();
  for (const c of survivors) parent.set(c, c);

  function find(x: string): string {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let cur = x;
    while (parent.get(cur) !== root) { const next = parent.get(cur)!; parent.set(cur, root); cur = next; }
    return root;
  }
  function union(a: string, b: string): void {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }

  for (const cell of survivors) {
    for (const neighbor of gridDisk(cell, 1)) {
      if (neighbor !== cell && survivorSet.has(neighbor)) union(cell, neighbor);
    }
  }

  const groups = new Map<string, string[]>();
  for (const c of survivors) {
    const root = find(c);
    const arr = groups.get(root);
    if (arr) arr.push(c); else groups.set(root, [c]);
  }
  return Array.from(groups.values())
    .map((g) => g.sort())
    .sort((a, b) => a[0].localeCompare(b[0]));
}
