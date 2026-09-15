import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { bboxOf, linesFromGeoJson, packWithMapFeatures, structuralRowToMapFeature } from "./structuralPack.ts";

Deno.test("linesFromGeoJson: LineString wraps into a single-line array", () => {
  const geojson = JSON.stringify({ type: "LineString", coordinates: [[49.0, 11.0], [49.1, 11.1]] });
  const lines = linesFromGeoJson(geojson);
  assertEquals(lines, [[[49.0, 11.0], [49.1, 11.1]]]);
});

Deno.test("linesFromGeoJson: MultiLineString passes through each line", () => {
  const geojson = JSON.stringify({
    type: "MultiLineString",
    coordinates: [[[49.0, 11.0], [49.1, 11.1]], [[50.0, 12.0], [50.1, 12.1]]],
  });
  const lines = linesFromGeoJson(geojson);
  assertEquals(lines?.length, 2);
});

Deno.test("linesFromGeoJson: unsupported geometry type returns null, not a guess", () => {
  const geojson = JSON.stringify({ type: "Point", coordinates: [49.0, 11.0] });
  assertEquals(linesFromGeoJson(geojson), null);
});

Deno.test("linesFromGeoJson: malformed JSON returns null rather than throwing", () => {
  assertEquals(linesFromGeoJson("not json"), null);
});

Deno.test("bboxOf: computes the enclosing box across all points of all lines", () => {
  const bbox = bboxOf([[[49.0, 11.0], [49.5, 11.5]], [[48.5, 10.5], [49.2, 11.2]]]);
  assertEquals(bbox, [48.5, 10.5, 49.5, 11.5]);
});

Deno.test("structuralRowToMapFeature: 'fault' maps to kind 'fault' — scoreable", () => {
  const f = structuralRowToMapFeature({
    id: "f1", feature_type: "fault", name: "Test Fault", source_key: "abbate_1994",
    attributes: { trend: "NE-SW" },
    geojson: JSON.stringify({ type: "LineString", coordinates: [[49.0, 11.0], [49.1, 11.1]] }),
  });
  assert(f !== null);
  assertEquals(f!.kind, "fault");
  assertEquals(f!.id, "f1");
  assertEquals(f!.source, "abbate_1994");
  assertEquals(f!.bbox, [49.0, 11.0, 49.1, 11.1]);
});

Deno.test("[measured leakage] structuralRowToMapFeature: 'lineament' maps to kind 'lineament', NOT 'fault'", () => {
  // lineaments measured leaking 4.3x (evidenceRoles.ts/ROLES_NOT_SCORED) —
  // prospectivityEvidence()'s own kind==='fault'||'contact' filter is what
  // keeps them out of scoring, so this row must never be mislabeled as a
  // scoreable kind.
  const f = structuralRowToMapFeature({
    id: "l1", feature_type: "lineament", name: null, source_key: "dem_derived", attributes: null,
    geojson: JSON.stringify({ type: "LineString", coordinates: [[49.0, 11.0], [49.1, 11.1]] }),
  });
  assert(f !== null);
  assertEquals(f!.kind, "lineament");
  assert(f!.kind !== "fault" && f!.kind !== "contact");
});

Deno.test("structuralRowToMapFeature: unrecognized feature_type maps to 'other'", () => {
  const f = structuralRowToMapFeature({
    id: "x1", feature_type: "shear_zone_survey", name: null, source_key: null, attributes: null,
    geojson: JSON.stringify({ type: "LineString", coordinates: [[49.0, 11.0], [49.1, 11.1]] }),
  });
  assertEquals(f!.kind, "other");
});

Deno.test("structuralRowToMapFeature: unparseable geometry drops the row (returns null)", () => {
  const f = structuralRowToMapFeature({
    id: "bad", feature_type: "fault", name: null, source_key: null, attributes: null,
    geojson: JSON.stringify({ type: "Polygon", coordinates: [] }),
  });
  assertEquals(f, null);
});

Deno.test("packWithMapFeatures: every field empty except mapFeatures", () => {
  const feature = structuralRowToMapFeature({
    id: "f1", feature_type: "fault", name: null, source_key: null, attributes: null,
    geojson: JSON.stringify({ type: "LineString", coordinates: [[49.0, 11.0], [49.1, 11.1]] }),
  })!;
  const pack = packWithMapFeatures([feature]);
  assertEquals(pack.mapFeatures, [feature]);
  assertEquals(pack.geology, []);
  assertEquals(pack.occurrences, []);
  assertEquals(pack.terrain, []);
  assertEquals(pack.land, []);
});
