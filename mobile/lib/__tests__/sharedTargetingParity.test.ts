// Solo↔Team parity (Phase 1) — Jest/Node side. Same fixture, same shared
// module, as shared/geo-core/gie/prospectivityEvidence.test.ts (Deno side).
// Both import the identical `prospectivityEvidence`/`computeConfidence` from
// shared/geo-core (NOT the mobile shim in lib/geo/targeting.ts, which injects
// Solo's pack priors — this test deliberately exercises the bare shared
// module, the exact form Team's server calls it in). If these two ever
// disagree, the shared module is not actually deterministic across runtimes,
// which is the one thing this whole migration promises.
import { collapseGroups, prospectivityEvidence } from "../../../shared/geo-core/gie/prospectivityEvidence.ts";
import { computeConfidence } from "../../../shared/geo-core/confidence.ts";
import {
  buildParityGeoContext, PARITY_RADIUS_M, PARITY_EXPECTED_SCORE,
} from "../../../shared/geo-core/gie/__fixtures__/parityFixture.ts";

describe("shared targeting parity (Solo Jest/Node runtime vs Team Deno runtime)", () => {
  test("no-pack (Team-shaped) score matches the pinned fixture value", () => {
    const ctx = buildParityGeoContext();
    const scored = prospectivityEvidence(ctx, PARITY_RADIUS_M, undefined, undefined, {});
    const { score } = computeConfidence(collapseGroups(scored));
    expect(score).toBe(PARITY_EXPECTED_SCORE);
  });

  test("no-pack score is deterministic across repeated calls", () => {
    const ctx = buildParityGeoContext();
    const run = () => computeConfidence(collapseGroups(
      prospectivityEvidence(ctx, PARITY_RADIUS_M, undefined, undefined, {}),
    )).score;
    expect(run()).toBe(run());
  });

  test("occurrence/association/community evidence roles are present without a pack", () => {
    const ctx = buildParityGeoContext();
    const scored = prospectivityEvidence(ctx, PARITY_RADIUS_M, undefined, undefined, {});
    const roles = new Set(scored.map((s) => s.role));
    expect(roles.has("occurrence")).toBe(true);
    expect(roles.has("association")).toBe(true);
    expect(roles.has("community")).toBe(true);
    // Structural/lithology/terrain need a pack — none supplied, so none present.
    expect(roles.has("structural")).toBe(false);
    expect(roles.has("geology")).toBe(false);
    expect(roles.has("terrain")).toBe(false);
  });
});
