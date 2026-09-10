// deno test --allow-net=esm.sh supabase/functions/generate-mission-cells/h3fill.test.ts
//
// Pure logic, no DB/network beyond the h3-js CDN import — exercises the
// actual polygon-fill algorithm the Edge Function will run in production,
// not a mock of it.
import { assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { fillMultiPolygon, InvalidAreaGeometryError, type GeoJsonMultiPolygon } from "./h3fill.ts";

const RES = 7; // the shared H3_RESOLUTION this codebase uses everywhere

// A ~11km x 11km box (near the Somalia/Kenya border) — big enough to span
// several resolution-7 (~5.16km²) cells.
const BOX_A: number[][] = [
  [45.00, 2.00], [45.10, 2.00], [45.10, 2.10], [45.00, 2.10], [45.00, 2.00],
];
// A disjoint, smaller box far from BOX_A.
const BOX_B: number[][] = [
  [46.00, 3.00], [46.05, 3.00], [46.05, 3.05], [46.00, 3.05], [46.00, 3.00],
];
// A hole roughly centred inside BOX_A, well clear of its edges.
const HOLE_IN_A: number[][] = [
  [45.03, 2.03], [45.07, 2.03], [45.07, 2.07], [45.03, 2.07], [45.03, 2.03],
];

function multiPolygon(polygons: number[][][][]): GeoJsonMultiPolygon {
  return { type: "MultiPolygon", coordinates: polygons };
}

Deno.test("single polygon enumerates a non-empty, deterministic cell set", () => {
  const geo = multiPolygon([[BOX_A]]);
  const cells = fillMultiPolygon(geo, RES);
  assertEquals(cells.length > 0, true);
  assertEquals(new Set(cells).size, cells.length, "no duplicate cells");
});

Deno.test("repeated enumeration of the same area is deterministic", () => {
  const geo = multiPolygon([[BOX_A]]);
  const first = fillMultiPolygon(geo, RES);
  const second = fillMultiPolygon(geo, RES);
  assertEquals(first, second);
});

Deno.test("multipolygon: both disjoint components contribute cells, none dropped", () => {
  const onlyA = new Set(fillMultiPolygon(multiPolygon([[BOX_A]]), RES));
  const onlyB = new Set(fillMultiPolygon(multiPolygon([[BOX_B]]), RES));
  const both = fillMultiPolygon(multiPolygon([[BOX_A], [BOX_B]]), RES);

  // Every cell from each independently-filled component must appear in the
  // combined result — a dropped component would fail this.
  for (const c of onlyA) assertEquals(both.includes(c), true, `missing A cell ${c}`);
  for (const c of onlyB) assertEquals(both.includes(c), true, `missing B cell ${c}`);
  assertEquals(both.length, new Set([...onlyA, ...onlyB]).size);
});

Deno.test("polygon with a hole excludes the hole's cells, does not fill it", () => {
  const withoutHole = fillMultiPolygon(multiPolygon([[BOX_A]]), RES);
  const withHole = fillMultiPolygon(multiPolygon([[BOX_A, HOLE_IN_A]]), RES);

  assertEquals(withHole.length < withoutHole.length, true, "the hole must remove at least one cell");
  // Every cell that survives the hole must still be a cell of the un-holed box
  // (the hole only ever REMOVES cells, never adds or moves one).
  const withoutSet = new Set(withoutHole);
  for (const c of withHole) assertEquals(withoutSet.has(c), true);
});

Deno.test("wrong geometry type is rejected", () => {
  assertThrows(
    () => fillMultiPolygon({ type: "Polygon", coordinates: [BOX_A] } as unknown as GeoJsonMultiPolygon, RES),
    InvalidAreaGeometryError,
  );
});

Deno.test("empty coordinates array is rejected", () => {
  assertThrows(() => fillMultiPolygon(multiPolygon([]), RES), InvalidAreaGeometryError);
});

Deno.test("a polygon with no rings is rejected", () => {
  assertThrows(() => fillMultiPolygon(multiPolygon([[]]), RES), InvalidAreaGeometryError);
});

Deno.test("null/undefined geometry is rejected, not a crash", () => {
  assertThrows(
    () => fillMultiPolygon(null as unknown as GeoJsonMultiPolygon, RES),
    InvalidAreaGeometryError,
  );
});

Deno.test("a real-world microscopic polygon (below one cell) is rejected, not silently empty", () => {
  const tiny: number[][] = [
    [45.000, 2.000], [45.0001, 2.000], [45.0001, 2.0001], [45.000, 2.0001], [45.000, 2.000],
  ];
  assertThrows(() => fillMultiPolygon(multiPolygon([[tiny]]), RES), InvalidAreaGeometryError);
});
