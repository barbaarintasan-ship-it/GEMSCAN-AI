// Solo↔Team parity fixture (Phase 1) — ONE fixture, imported by both the Jest
// test (mobile/lib/__tests__/sharedTargetingParity.test.ts, Node runtime) and
// the Deno test (shared/geo-core/gie/prospectivityEvidence.test.ts). Both
// tests feed this SAME object into the SAME shared `prospectivityEvidence()`
// with no pack/packOps (the evidence Team can compute today: occurrence,
// association, community, geology-unit) and assert an IDENTICAL score — proof
// that the shared module behaves identically under both runtimes, not merely
// "looks similar".
import type { GeoContext } from "../../types.ts";

export function buildParityGeoContext(): GeoContext {
  return {
    location: { lat: 9.55, lng: 44.05 },
    geology: { unit: "plutonic" },
    formations: [],
    lithology: [],
    hostRocks: [],
    faults: [],
    intrusions: [],
    metamorphism: {},
    knownOccurrences: [
      { commodity: "Gold", distanceM: 900 },
      { commodity: "Gold", distanceM: 4200 },
    ],
    commodityAssociations: [{ commodity: "Gold", weight: 0.3 }],
    geochemistry: { anomalies: [] },
    geophysics: { anomalies: [] },
    remoteSensing: { alteration: [] },
    historicalReports: [],
    communityEvidence: { verifiedScans: 1 },
    reasoningFactors: [],
    evidence: { providers: [], datasets: [] },
    confidence: { overall: "Low", score: 0, byProvider: {}, factors: [] },
    meta: {
      engineVersion: "parity-fixture-1.0.0",
      generatedAt: "2026-01-01T00:00:00.000Z",
      providersRun: [],
      providersFailed: [],
      cache: "miss",
    },
  };
}

export const PARITY_RADIUS_M = 10_000;

/**
 * The expected result, computed once and pinned here so both tests assert
 * against the SAME number rather than against each other (which would let a
 * shared bug through both). Recompute by hand only if the validated formula
 * itself changes — which Phase 1 must not do.
 */
export const PARITY_EXPECTED_SCORE = 0.93;
