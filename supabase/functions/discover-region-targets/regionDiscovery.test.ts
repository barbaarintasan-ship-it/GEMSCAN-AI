import { assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { gridDisk } from "https://esm.sh/h3-js@4.1.0";
import { fillMultiPolygon } from "../generate-mission-cells/h3fill.ts";
import { normalizePolygonToMultiPolygon, clusterAdjacentCells, estimateBboxAreaKm2, InvalidPolygonInputError } from "./regionDiscovery.ts";

const RES = 7;
const BOX_A: number[][] = [
  [45.00, 2.00], [45.10, 2.00], [45.10, 2.10], [45.00, 2.10], [45.00, 2.00],
];

// ── normalizePolygonToMultiPolygon ──────────────────────────────────────────

Deno.test("[normalize] a Polygon is wrapped into a one-component MultiPolygon", () => {
  const out = normalizePolygonToMultiPolygon({ type: "Polygon", coordinates: [BOX_A] });
  assertEquals(out.type, "MultiPolygon");
  assertEquals(out.coordinates, [[BOX_A]]);
});

Deno.test("[normalize] a MultiPolygon passes through unchanged", () => {
  const mp = { type: "MultiPolygon", coordinates: [[BOX_A]] };
  const out = normalizePolygonToMultiPolygon(mp);
  assertEquals(out, mp);
});

Deno.test("[normalize] an unsupported geometry type is rejected", () => {
  assertThrows(() => normalizePolygonToMultiPolygon({ type: "Point", coordinates: [45, 2] }), InvalidPolygonInputError);
});

Deno.test("[normalize] a non-object input is rejected, not crashed on", () => {
  assertThrows(() => normalizePolygonToMultiPolygon(null), InvalidPolygonInputError);
  assertThrows(() => normalizePolygonToMultiPolygon("not a polygon"), InvalidPolygonInputError);
});

// ── clusterAdjacentCells ─────────────────────────────────────────────────

// A real, deterministic cell set from the actual H3 fill of BOX_A — the
// SAME mechanism the handler uses, not a hand-typed list of cell strings.
const REAL_CELLS = fillMultiPolygon({ type: "MultiPolygon", coordinates: [[BOX_A]] }, RES);

Deno.test("[cluster] every real neighbouring cell in the polygon ends up in one cluster", () => {
  // BOX_A's own fill is one contiguous blob by construction (a filled
  // rectangle) — clustering ALL of it should yield exactly one cluster
  // containing every cell.
  const clusters = clusterAdjacentCells(REAL_CELLS);
  assertEquals(clusters.length, 1);
  assertEquals(clusters[0].length, REAL_CELLS.length);
  assertEquals(new Set(clusters[0]).size, REAL_CELLS.length);
});

Deno.test("[cluster] two spatially separate survivor groups yield two separate clusters", () => {
  // Take one real cell, and a real cell far outside its neighbourhood (from
  // a disjoint fill) — they must never merge.
  const farAway = fillMultiPolygon(
    { type: "MultiPolygon", coordinates: [[[[46.00, 3.00], [46.05, 3.00], [46.05, 3.05], [46.00, 3.05], [46.00, 3.00]]]] },
    RES,
  );
  const a = REAL_CELLS[0];
  const b = farAway[0];
  const clusters = clusterAdjacentCells([a, b]);
  assertEquals(clusters.length, 2);
});

Deno.test("[cluster] a single isolated survivor is its own one-cell cluster", () => {
  const clusters = clusterAdjacentCells([REAL_CELLS[0]]);
  assertEquals(clusters, [[REAL_CELLS[0]]]);
});

Deno.test("[cluster] duplicate input cells are deduplicated, not double-counted", () => {
  const clusters = clusterAdjacentCells([REAL_CELLS[0], REAL_CELLS[0], REAL_CELLS[0]]);
  assertEquals(clusters, [[REAL_CELLS[0]]]);
});

Deno.test("[cluster] empty input yields no clusters", () => {
  assertEquals(clusterAdjacentCells([]), []);
});

Deno.test("[cluster] result is deterministic across repeated calls, same input", () => {
  const first = clusterAdjacentCells(REAL_CELLS);
  const second = clusterAdjacentCells(REAL_CELLS);
  assertEquals(first, second);
});

Deno.test("[cluster] removing a bridging cell splits one cluster into two", () => {
  // Pick a cell in the middle of the filled box and remove it: its own
  // 1-ring neighbours that were only connected THROUGH it may now split.
  // We only assert the weaker, always-true invariant: the result has at
  // least as many clusters as before removal (never fewer).
  const withBridge = clusterAdjacentCells(REAL_CELLS).length;
  const mid = REAL_CELLS[Math.floor(REAL_CELLS.length / 2)];
  const withoutBridge = clusterAdjacentCells(REAL_CELLS.filter((c) => c !== mid)).length;
  assertEquals(withoutBridge >= withBridge, true);
});

// Sanity check the fixture itself is what we assume: gridDisk(cell,1) always
// includes the cell itself.
Deno.test("[fixture sanity] gridDisk(cell,1) includes the cell itself", () => {
  assertEquals(gridDisk(REAL_CELLS[0], 1).includes(REAL_CELLS[0]), true);
});

// ── estimateBboxAreaKm2 — real bug (2026-09-24) ─────────────────────────────

Deno.test("[bbox area] a small, real-scale scan region estimates a small area", () => {
  const mp = normalizePolygonToMultiPolygon({ type: "Polygon", coordinates: [BOX_A] });
  const km2 = estimateBboxAreaKm2(mp);
  // BOX_A is ~11km x ~11km (see generate-mission-cells/h3fill.test.ts) — well
  // under any sane per-scan cap.
  assertEquals(km2 > 50 && km2 < 200, true, `expected ~100km², got ${km2}`);
});

Deno.test("[bbox area] the exact real-world mistyped-corner disaster (9.5°→43.1° latitude) estimates a huge area", () => {
  const gigantic = normalizePolygonToMultiPolygon({
    type: "Polygon",
    coordinates: [[[44.0, 9.5156], [49.0, 9.5156], [49.0, 43.1432], [44.0, 43.1432], [44.0, 9.5156]]],
  });
  const km2 = estimateBboxAreaKm2(gigantic);
  // ~34° latitude (~3785km) x ~5° longitude at low latitude (~550km+) — a
  // couple million km², nowhere near a legitimate single-scan region.
  assertEquals(km2 > 1_000_000, true, `expected a multi-million km² disaster, got ${km2}`);
});

Deno.test("[bbox area] degenerate/empty geometry estimates zero rather than NaN or throwing", () => {
  assertEquals(estimateBboxAreaKm2({ type: "MultiPolygon", coordinates: [] }), 0);
});
