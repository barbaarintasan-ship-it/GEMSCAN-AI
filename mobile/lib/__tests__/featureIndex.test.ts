// PHASE 3 — the spatial index must be a PURE optimization.
//
// featuresNear now uses the grid index; this proves its output is byte-identical
// to the original linear scan, on the real 24k-feature pack and on edge cases. If
// featuresNear is identical, so is everything downstream (prospectivityEvidence,
// coverageAt, targeting.rank): same candidate cells, scores, geology, distances.
import { featuresNear, type NearbyFeature } from "../geo/terrainProviders.ts";
import { loadBundledPackFiles } from "../geo/bundledPack.ts";
import { readPack } from "../../../shared/geo-core/pack/read.ts";
import {
  bboxContains, bboxPadding, pointToPolylineM, type Position,
} from "../../../shared/geo-core/geo/spatial.ts";
import type { PackMapFeature } from "../../../shared/geo-core/pack/types.ts";

// The ORIGINAL implementation, verbatim, as the reference oracle.
function featuresNearLinear(
  features: PackMapFeature[], lat: number, lng: number, radiusM: number,
): NearbyFeature[] {
  const { dLat, dLng } = bboxPadding(lat, radiusM);
  const out: NearbyFeature[] = [];
  for (const f of features) {
    const padded: [number, number, number, number] = [
      f.bbox[0] - dLng, f.bbox[1] - dLat, f.bbox[2] + dLng, f.bbox[3] + dLat,
    ];
    if (!bboxContains(padded, lng, lat)) continue;
    let best = Infinity;
    for (const line of f.lines) {
      const d = pointToPolylineM({ lat, lng }, line as Position[]);
      if (d < best) best = d;
    }
    if (best <= radiusM) {
      out.push({ id: f.id, kind: f.kind, name: f.name, distanceM: best, source: f.source });
    }
  }
  out.sort((a, b) => a.distanceM - b.distanceM);
  return out;
}

const files = loadBundledPackFiles();
const pack = files ? readPack(files) : null;

function feat(id: string, kind: PackMapFeature["kind"], line: [number, number][]): PackMapFeature {
  const xs = line.map((p) => p[0]), ys = line.map((p) => p[1]);
  return {
    id, kind, name: null, source: "test", attributes: {},
    lines: [line as unknown as Position[]],
    bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
  } as PackMapFeature;
}

describe("featureIndex — indexed featuresNear equals the linear scan", () => {
  it("handles empty and single-feature packs identically", () => {
    expect(featuresNear([], 9.5, 44, 5000)).toEqual(featuresNearLinear([], 9.5, 44, 5000));
    const one = [feat("a", "fault", [[44, 9.5], [44.1, 9.6]])];
    for (const r of [100, 1000, 5000, 50000]) {
      expect(featuresNear(one, 9.5, 44, r)).toEqual(featuresNearLinear(one, 9.5, 44, r));
    }
  });

  it("preserves tie-break order for equal-distance features", () => {
    // Three identical geometries at the same distance — order must follow array order.
    const same: [number, number][] = [[44, 9.5], [44, 9.6]];
    const fs = [feat("z", "fault", same), feat("m", "contact", same), feat("a", "drainage", same)];
    const got = featuresNear(fs, 9.55, 44.01, 5000).map((f) => f.id);
    const ref = featuresNearLinear(fs, 9.55, 44.01, 5000).map((f) => f.id);
    expect(got).toEqual(ref);
  });

  it("works across negative latitudes and grid-cell boundaries", () => {
    const fs = [
      feat("s", "fault", [[42, -1.6], [42.05, -1.5]]),
      feat("b", "contact", [[42.0, 0.0], [42.1, 0.05]]),  // straddles lat 0 cell edge
      feat("c", "drainage", [[41.99, 9.999], [42.01, 10.001]]),
    ];
    for (const [lat, lng] of [[-1.55, 42.02], [0.0, 42.05], [10.0, 42.0], [5.0, 50.0]]) {
      for (const r of [500, 5000, 30000]) {
        expect(featuresNear(fs, lat, lng, r)).toEqual(featuresNearLinear(fs, lat, lng, r));
      }
    }
  });

  (pack ? it : it.skip)("is identical on the REAL pack across a grid of query points", () => {
    const d = pack!.data;
    let compared = 0;
    // Sweep Somalia; include tight and wide radii. Every point must match exactly.
    for (let lat = 0; lat <= 11.5; lat += 1.3) {
      for (let lng = 41; lng <= 51; lng += 1.1) {
        for (const r of [1000, 10000, 50000]) {
          const got = featuresNear(d.mapFeatures, lat, lng, r);
          const ref = featuresNearLinear(d.mapFeatures, lat, lng, r);
          expect(got).toEqual(ref);
          compared++;
        }
      }
    }
    expect(compared).toBeGreaterThan(200);
  });

  (pack ? it : it.skip)("is identical when standing exactly on real features", () => {
    const d = pack!.data;
    const sample = d.mapFeatures.filter((_, i) => i % 811 === 0).slice(0, 30);
    for (const f of sample) {
      const [lng, lat] = f.lines[0][0] as unknown as [number, number];
      for (const r of [500, 5000, 25000]) {
        expect(featuresNear(d.mapFeatures, lat, lng, r))
          .toEqual(featuresNearLinear(d.mapFeatures, lat, lng, r));
      }
    }
  });
});
