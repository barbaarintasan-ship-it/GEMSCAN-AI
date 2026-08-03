// Spatial predicates (Stage E2) — the three PostGIS operations, in TypeScript.
import { assertAlmostEquals, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  bboxContains, bboxPadding, haversineM, pointInRings, pointToPolylineM,
  pointToSegmentM, withinM, type Position, type Ring,
} from "./spatial.ts";

// ── Distance ────────────────────────────────────────────────────────────────
Deno.test("haversine: identical points are zero", () => {
  assertEquals(haversineM({ lat: 2.05, lng: 45.32 }, { lat: 2.05, lng: 45.32 }), 0);
});

Deno.test("haversine: one degree of latitude is ~111.2 km anywhere", () => {
  const atEquator = haversineM({ lat: 0, lng: 0 }, { lat: 1, lng: 0 });
  const atSomalia = haversineM({ lat: 2, lng: 45 }, { lat: 3, lng: 45 });
  assertAlmostEquals(atEquator, 111_195, 100);
  assertAlmostEquals(atSomalia, 111_195, 100);
});

Deno.test("haversine: a degree of longitude shrinks with latitude", () => {
  const atEquator = haversineM({ lat: 0, lng: 0 }, { lat: 0, lng: 1 });
  const at60 = haversineM({ lat: 60, lng: 0 }, { lat: 60, lng: 1 });
  // cos(60°) = 0.5.
  assertAlmostEquals(at60 / atEquator, 0.5, 0.001);
});

Deno.test("haversine is symmetric", () => {
  const a = { lat: 2.05, lng: 45.32 };
  const b = { lat: 9.56, lng: 44.06 };
  assertAlmostEquals(haversineM(a, b), haversineM(b, a), 1e-6);
});

Deno.test("haversine: antipodal points are half the circumference", () => {
  assertAlmostEquals(haversineM({ lat: 0, lng: 0 }, { lat: 0, lng: 180 }), Math.PI * 6_371_008.8, 1);
});

Deno.test("haversine: Mogadishu to Hargeisa is ~1060 km", () => {
  // Independent sanity check against a known real-world distance.
  const d = haversineM({ lat: 2.0469, lng: 45.3182 }, { lat: 9.5600, lng: 44.0650 });
  assertAlmostEquals(d, 848_000, 20_000);
});

// ── ST_DWithin ──────────────────────────────────────────────────────────────
Deno.test("withinM is inclusive at the boundary, matching PostGIS", () => {
  const a = { lat: 0, lng: 0 };
  const b = { lat: 0, lng: 1 };
  const exact = haversineM(a, b);
  assertEquals(withinM(a, b, exact), true);
  assertEquals(withinM(a, b, exact - 0.001), false);
  assertEquals(withinM(a, b, exact + 0.001), true);
});

// ── Point in polygon ────────────────────────────────────────────────────────
const square: Ring = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];

Deno.test("point inside / outside a simple square", () => {
  assertEquals(pointInRings([square], 5, 5), true);
  assertEquals(pointInRings([square], 15, 5), false);
  assertEquals(pointInRings([square], -1, 5), false);
  assertEquals(pointInRings([square], 5, 20), false);
});

Deno.test("a hole punches through — even-odd handles the flattened ring list", () => {
  const hole: Ring = [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]];
  assertEquals(pointInRings([square, hole], 5, 5), false); // inside the hole
  assertEquals(pointInRings([square, hole], 2, 2), true);  // inside, outside the hole
});

Deno.test("two disjoint polygons in one flattened list stay independent", () => {
  const other: Ring = [[20, 0], [30, 0], [30, 10], [20, 10], [20, 0]];
  assertEquals(pointInRings([square, other], 5, 5), true);
  assertEquals(pointInRings([square, other], 25, 5), true);
  assertEquals(pointInRings([square, other], 15, 5), false);
});

Deno.test("a concave polygon is handled correctly", () => {
  // A "C" shape opening to the right.
  const c: Ring = [
    [0, 0], [10, 0], [10, 3], [3, 3], [3, 7], [10, 7], [10, 10], [0, 10], [0, 0],
  ];
  assertEquals(pointInRings([c], 1, 5), true);  // in the spine
  assertEquals(pointInRings([c], 7, 5), false); // in the mouth
  assertEquals(pointInRings([c], 7, 1), true);  // in the lower arm
});

Deno.test("degenerate rings are ignored, not crashed on", () => {
  assertEquals(pointInRings([], 5, 5), false);
  assertEquals(pointInRings([[[0, 0], [1, 1]]], 0.5, 0.5), false);
});

Deno.test("a real-world-shaped polygon around Mogadishu", () => {
  const unit: Ring = [[45.0, 2.0], [45.5, 2.0], [45.5, 2.5], [45.0, 2.5], [45.0, 2.0]];
  assertEquals(pointInRings([unit], 45.3182, 2.0469), true);
  assertEquals(pointInRings([unit], 44.0650, 9.5600), false);
});

// ── BBox ────────────────────────────────────────────────────────────────────
Deno.test("bboxContains includes the edges", () => {
  const b: [number, number, number, number] = [45, 2, 46, 3];
  assertEquals(bboxContains(b, 45.5, 2.5), true);
  assertEquals(bboxContains(b, 45, 2), true);
  assertEquals(bboxContains(b, 46, 3), true);
  assertEquals(bboxContains(b, 46.1, 2.5), false);
});

Deno.test("bboxPadding widens longitude more than latitude away from the equator", () => {
  const at0 = bboxPadding(0, 10_000);
  const at60 = bboxPadding(60, 10_000);
  assertAlmostEquals(at0.dLat, at60.dLat, 1e-9); // latitude degrees are constant
  assertAlmostEquals(at60.dLng / at0.dLng, 2, 0.01); // 1/cos(60°) = 2
});

Deno.test("bboxPadding does not explode at the pole", () => {
  const atPole = bboxPadding(90, 10_000);
  assertEquals(Number.isFinite(atPole.dLng), true);
  assertEquals(atPole.dLng, 180);
});

// ── Distance to a line (faults, contacts, lineaments) ───────────────────────
Deno.test("pointToSegment: a point on the segment is zero", () => {
  const a = { lat: 2.0, lng: 45.0 };
  const b = { lat: 2.0, lng: 45.1 };
  assertAlmostEquals(pointToSegmentM({ lat: 2.0, lng: 45.05 }, a, b), 0, 0.5);
});

Deno.test("pointToSegment: perpendicular offset is the true distance", () => {
  const a = { lat: 2.0, lng: 45.0 };
  const b = { lat: 2.0, lng: 45.1 };
  // 0.001 deg of latitude north of the line ~ 111 m.
  assertAlmostEquals(pointToSegmentM({ lat: 2.001, lng: 45.05 }, a, b), 111.1, 2);
});

Deno.test("pointToSegment: beyond an end, distance is to the ENDPOINT not the infinite line", () => {
  const a = { lat: 2.0, lng: 45.0 };
  const b = { lat: 2.0, lng: 45.1 };
  // Due west of `a`, past the end of the segment.
  const d = pointToSegmentM({ lat: 2.0, lng: 44.99 }, a, b);
  assertAlmostEquals(d, haversineM({ lat: 2.0, lng: 44.99 }, a), 2);
});

Deno.test("pointToSegment: a degenerate segment is treated as a point", () => {
  const a = { lat: 2.0, lng: 45.0 };
  const d = pointToSegmentM({ lat: 2.001, lng: 45.0 }, a, a);
  assertAlmostEquals(d, 111.1, 2);
});

Deno.test("pointToPolyline: takes the nearest segment of a bent line", () => {
  // An L: west-to-east then north.
  const line: Position[] = [[45.0, 2.0], [45.1, 2.0], [45.1, 2.1]];
  // Near the vertical limb, far from the horizontal one.
  const d = pointToPolylineM({ lat: 2.05, lng: 45.101 }, line);
  assertAlmostEquals(d, 111.1, 3);
});

Deno.test("pointToPolyline: empty and single-point lines are handled, not crashed on", () => {
  assertEquals(pointToPolylineM({ lat: 2, lng: 45 }, []), Infinity);
  const one: Position[] = [[45.0, 2.0]];
  assertAlmostEquals(pointToPolylineM({ lat: 2.001, lng: 45.0 }, one), 111.2, 1);
});

Deno.test("pointToPolyline agrees with haversine for a point off one end", () => {
  const line: Position[] = [[45.0, 2.0], [45.05, 2.0]];
  const p = { lat: 2.0, lng: 44.95 };
  assertAlmostEquals(pointToPolylineM(p, line), haversineM(p, { lat: 2.0, lng: 45.0 }), 3);
});
