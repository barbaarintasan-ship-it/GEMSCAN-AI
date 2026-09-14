// Solo↔Team parity (Phase 1) — Deno side. Same fixture, same shared module,
// as mobile/lib/__tests__/sharedTargetingParity.test.ts (Jest/Node side). If
// these two ever disagree, the shared module is not actually deterministic
// across runtimes, which is the one thing this whole migration promises.
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { collapseGroups, prospectivityEvidence } from "./prospectivityEvidence.ts";
import { computeConfidence } from "../confidence.ts";
import {
  buildParityGeoContext, PARITY_RADIUS_M, PARITY_EXPECTED_SCORE,
} from "./__fixtures__/parityFixture.ts";

Deno.test("prospectivityEvidence: no-pack (Team-shaped) score matches the pinned fixture value", () => {
  const ctx = buildParityGeoContext();
  const scored = prospectivityEvidence(ctx, PARITY_RADIUS_M, undefined, undefined, {});
  const { score } = computeConfidence(collapseGroups(scored));
  assertEquals(score, PARITY_EXPECTED_SCORE);
});

Deno.test("prospectivityEvidence: no-pack score is deterministic across repeated calls", () => {
  const ctx = buildParityGeoContext();
  const a = computeConfidence(collapseGroups(
    prospectivityEvidence(ctx, PARITY_RADIUS_M, undefined, undefined, {}),
  )).score;
  const b = computeConfidence(collapseGroups(
    prospectivityEvidence(ctx, PARITY_RADIUS_M, undefined, undefined, {}),
  )).score;
  assertEquals(a, b);
});

Deno.test("prospectivityEvidence: occurrence/association/community evidence roles are present without a pack", () => {
  const ctx = buildParityGeoContext();
  const scored = prospectivityEvidence(ctx, PARITY_RADIUS_M, undefined, undefined, {});
  const roles = new Set(scored.map((s) => s.role));
  assertEquals(roles.has("occurrence"), true);
  assertEquals(roles.has("association"), true);
  assertEquals(roles.has("community"), true);
  // Structural/lithology/terrain need a pack — none supplied, so none present.
  assertEquals(roles.has("structural"), false);
  assertEquals(roles.has("geology"), false);
  assertEquals(roles.has("terrain"), false);
});
