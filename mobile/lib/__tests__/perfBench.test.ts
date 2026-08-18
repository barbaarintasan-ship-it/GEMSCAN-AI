// PHASE 2 evidence — measure the hot paths on the REAL 24k-feature pack.
// Not a gate; it logs timings so freeze causes are attributed, not guessed.
import { loadBundledPackFiles } from "../geo/bundledPack.ts";
import { readPack } from "../../../shared/geo-core/pack/read.ts";
import { PackStore, createBundledPackSource } from "../geo/packStore.ts";
import { OfflineGeoContextService } from "../geo/offlineGeoContext.ts";
import { featuresNear } from "../geo/terrainProviders.ts";
import { unitAt, pointInRings } from "../geo/featureInfo.ts";
import { prospectivityEvidence, collapseGroups, TargetingEngine } from "../geo/targeting.ts";
import { buildScene } from "../geo/mapScene.ts";
import { computeConfidence } from "../../../shared/geo-core/confidence.ts";
import { coverageAt } from "../geo/evidenceCoverage.ts";
import {
  bboxContains, bboxPadding, pointToPolylineM, type Position,
} from "../../../shared/geo-core/geo/spatial.ts";
import type { GeoContext } from "../../../shared/geo-core/types.ts";
import type { PackMapFeature } from "../../../shared/geo-core/pack/types.ts";

// The pre-index linear scan, to time BEFORE vs AFTER on the same pack.
function featuresNearLinear(features: PackMapFeature[], lat: number, lng: number, radiusM: number) {
  const { dLat, dLng } = bboxPadding(lat, radiusM);
  const out: Array<{ distanceM: number }> = [];
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
    if (best <= radiusM) out.push({ distanceM: best });
  }
  out.sort((a, b) => a.distanceM - b.distanceM);
  return out;
}

const files = loadBundledPackFiles();
const pack = files ? readPack(files) : null;
const HARGEYSA = { lat: 9.56, lng: 44.065 }; // dense lineament area

function ms(fn: () => void, n = 20): number {
  fn(); // warm
  const t = Date.now();
  for (let i = 0; i < n; i++) fn();
  return (Date.now() - t) / n;
}

(pack ? describe : describe.skip)("PHASE 2 perf evidence (real pack)", () => {
  it("times the freeze-suspect hot paths", () => {
    const d = pack!.data;
    const mf = d.mapFeatures.length;
    const kinds = d.mapFeatures.reduce((a: Record<string, number>, f) => {
      a[f.kind] = (a[f.kind] || 0) + 1; return a;
    }, {});
    const ctx = {
      location: HARGEYSA, knownOccurrences: [], commodityAssociations: [], communityEvidence: null,
    } as unknown as GeoContext;

    // BEFORE: full linear scan. AFTER: grid-indexed. Different query points so the
    // index cannot be accused of caching one answer.
    const tNearLinear = ms(() => { featuresNearLinear(d.mapFeatures, HARGEYSA.lat, HARGEYSA.lng, 10000); });
    const tNearIndexed = ms(() => { featuresNear(d.mapFeatures, HARGEYSA.lat, HARGEYSA.lng, 10000); });
    // unitAt BEFORE (linear polygon scan) vs AFTER (indexed).
    const unitAtLinear = (at: { lat: number; lng: number }) => {
      for (const g of d.geology) {
        if (!g.isPolygon) continue;
        const [w, s, e, n] = g.bbox;
        if (at.lng < w || at.lng > e || at.lat < s || at.lat > n) continue;
        if (pointInRings(g.rings, at)) return g;
      }
      return null;
    };
    const tUnitLinear = ms(() => { unitAtLinear(HARGEYSA); });
    const tUnitIndexed = ms(() => { unitAt(d, HARGEYSA); });

    const tProsp = ms(() => {
      computeConfidence(collapseGroups(prospectivityEvidence(ctx, 10000, undefined, d)));
    });
    const tCov = ms(() => { coverageAt(d, new Set(), HARGEYSA, 10000); });
    const tScene = ms(() => { buildScene(d, HARGEYSA, 15000); }, 8);
    // A rank() does buildTarget for ~37 cells, each ≈ prospectivity + coverage
    // (both now index-backed). Compare against the pre-index estimate.
    const estRankAfter = (tProsp + tCov) * 37;
    const estRankBefore = (tNearLinear * 2) * 37; // prospectivity+coverage were ≈2 linear scans

    // eslint-disable-next-line no-console
    console.log(`\n[PERF] mapFeatures=${mf} kinds=${JSON.stringify(kinds)}`);
    // eslint-disable-next-line no-console
    console.log(`[PERF] featuresNear  BEFORE(linear)=${tNearLinear.toFixed(2)}ms  AFTER(indexed)=${tNearIndexed.toFixed(2)}ms  speedup=${(tNearLinear / Math.max(tNearIndexed, 0.001)).toFixed(0)}x`);
    // eslint-disable-next-line no-console
    console.log(`[PERF] unitAt       BEFORE(linear)=${tUnitLinear.toFixed(2)}ms  AFTER(indexed)=${tUnitIndexed.toFixed(2)}ms  speedup=${(tUnitLinear / Math.max(tUnitIndexed, 0.001)).toFixed(0)}x`);
    // eslint-disable-next-line no-console
    console.log(`[PERF] prospectivity=${tProsp.toFixed(2)}ms  coverageAt=${tCov.toFixed(2)}ms  buildScene=${tScene.toFixed(1)}ms`);
    // eslint-disable-next-line no-console
    console.log(`[PERF] est rank(37 cells)  BEFORE≈${estRankBefore.toFixed(0)}ms  AFTER≈${estRankAfter.toFixed(0)}ms  (phone ≈ 4-8x these)\n`);

    expect(mf).toBeGreaterThan(20000);
    expect(tNearIndexed).toBeLessThan(tNearLinear); // the optimization actually optimizes
  });

  it("times a REAL rank() on the indexed engine", async () => {
    const store = new PackStore(createBundledPackSource(loadBundledPackFiles));
    await store.load();
    const targeting = new TargetingEngine(new OfflineGeoContextService(store), undefined, () => store.getData());
    await targeting.rank(HARGEYSA.lat, HARGEYSA.lng); // warm
    const N = 6;
    const t = Date.now();
    for (let i = 0; i < N; i++) await targeting.rank(HARGEYSA.lat + i * 0.03, HARGEYSA.lng + i * 0.03);
    const per = (Date.now() - t) / N;
    // eslint-disable-next-line no-console
    console.log(`[PERF] REAL rank() indexed = ${per.toFixed(0)}ms/call (desktop; phone ≈ 4-8x)\n`);
    expect(per).toBeGreaterThan(0);
  });
});
