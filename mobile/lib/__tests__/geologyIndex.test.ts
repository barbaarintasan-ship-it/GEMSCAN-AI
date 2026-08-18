// PHASE 3 — the geology spatial index must be a PURE optimization.
//
// unitAt now uses the bbox grid; this proves its result is byte-identical to the
// original linear polygon scan, on the real pack across a dense grid of points and
// standing exactly on real geology vertices. Identical unitAt ⇒ identical geology
// context, prospectivity lithology term, and coverage — nothing downstream moves.
import { unitAt } from "../geo/featureInfo.ts";
import { loadBundledPackFiles } from "../geo/bundledPack.ts";
import { readPack } from "../../../shared/geo-core/pack/read.ts";
import { pointInRings } from "../geo/featureInfo.ts";
import type { PackData, PackGeologyUnit } from "../../../shared/geo-core/pack/types.ts";

// The ORIGINAL implementation, verbatim, as the reference oracle.
function unitAtLinear(data: PackData, at: { lat: number; lng: number }): PackGeologyUnit | null {
  for (const g of data.geology) {
    if (!g.isPolygon) continue;
    const [w, s, e, n] = g.bbox;
    if (at.lng < w || at.lng > e || at.lat < s || at.lat > n) continue;
    if (pointInRings(g.rings, at)) return g;
  }
  return null;
}

const files = loadBundledPackFiles();
const pack = files ? readPack(files) : null;

describe("geologyIndex — indexed unitAt equals the linear scan", () => {
  (pack ? it : it.skip)("returns the identical unit across a dense grid of points", () => {
    const d = pack!.data;
    let hits = 0, compared = 0;
    for (let lat = -1.5; lat <= 11.8; lat += 0.35) {
      for (let lng = 41; lng <= 51.3; lng += 0.3) {
        const a = unitAt(d, { lat, lng });
        const b = unitAtLinear(d, { lat, lng });
        // Same object identity — the very same polygon, or both null.
        expect(a).toBe(b);
        if (a) hits++;
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(1000);
    expect(hits).toBeGreaterThan(50); // actually lands inside real units
  });

  (pack ? it : it.skip)("is identical standing exactly on real geology vertices", () => {
    const d = pack!.data;
    const polys = d.geology.filter((g) => g.isPolygon);
    const sample = polys.filter((_, i) => i % 7 === 0).slice(0, 40);
    for (const g of sample) {
      for (const ring of g.rings.slice(0, 1)) {
        for (const [lng, lat] of ring.slice(0, 6)) {
          expect(unitAt(d, { lat, lng })).toBe(unitAtLinear(d, { lat, lng }));
          // and just inside/outside the vertex
          expect(unitAt(d, { lat: lat + 1e-4, lng: lng + 1e-4 }))
            .toBe(unitAtLinear(d, { lat: lat + 1e-4, lng: lng + 1e-4 }));
        }
      }
    }
  });

  (pack ? it : it.skip)("agrees on points far outside all geology (null)", () => {
    const d = pack!.data;
    for (const [lat, lng] of [[20, 60], [-10, 30], [0, 0], [45, 45]]) {
      expect(unitAt(d, { lat, lng })).toBe(unitAtLinear(d, { lat, lng }));
      expect(unitAt(d, { lat, lng })).toBeNull();
    }
  });
});
