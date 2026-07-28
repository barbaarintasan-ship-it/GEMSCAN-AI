// Unit tests for review-sample (mocked deps; no DB/AI). Covers RBAC + decision gating.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildReviewPayload, type Deps, handleReview } from "./handler.ts";
import type { Actor } from "../_shared/enterprise/auth.ts";
import { canReview, canVerify, requireReviewer, requireVerifier } from "../_shared/enterprise/authz.ts";
import { ForbiddenError } from "../_shared/enterprise/errors.ts";

const geologist: Actor = { userId: "g1", email: "geo@x.co", contributorId: "c1", role: "geologist" };
const senior: Actor = { userId: "s1", email: "sen@x.co", contributorId: "c2", role: "senior_geologist" };
const collector: Actor = { userId: "col1", email: "col@x.co", contributorId: "c3", role: "field_contributor" };

function base(actor: Actor, over: Partial<Deps> = {}): Deps {
  return {
    resolveActor: async () => actor,
    requireEnterprise: async () => {},
    requireReviewer: requireReviewer,
    requireVerifier: requireVerifier,
    submitReview: async (_a, p) => ({ review_id: "r1", status: (p.decision === "draft" ? "draft" : "submitted"), decision: p.decision, round_no: 1 }),
    ...over,
  };
}
const req = (body: unknown) => new Request("https://x/review-sample", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

Deno.test("RBAC helpers: geologist reviews but cannot verify; senior can both", () => {
  assert(canReview(geologist) && !canVerify(geologist));
  assert(canReview(senior) && canVerify(senior));
  assert(!canReview(collector) && !canVerify(collector));
});

Deno.test("buildReviewPayload defaults decision=draft + reviewer_role from actor", () => {
  const p = buildReviewPayload(geologist, { sample_id: "s1" });
  assertEquals(p.decision, "draft");
  assertEquals(p.reviewer_role, "geologist");
});
Deno.test("buildReviewPayload rejects missing sample_id + bad decision", () => {
  let t = false; try { buildReviewPayload(geologist, {}); } catch { t = true; } assert(t);
  t = false; try { buildReviewPayload(geologist, { sample_id: "s1", decision: "nope" }); } catch { t = true; } assert(t);
});

Deno.test("geologist can Save Draft -> 200", async () => {
  const r = await handleReview(req({ sample_id: "s1", decision: "draft", review_notes: "wip" }), base(geologist));
  assertEquals(r.status, 200); assertEquals((await r.json()).status, "draft");
});
Deno.test("geologist can Reject / Needs-More-Data -> 200", async () => {
  for (const decision of ["reject", "needs_more_data"]) {
    const r = await handleReview(req({ sample_id: "s1", decision }), base(geologist));
    assertEquals(r.status, 200);
  }
});
Deno.test("geologist CANNOT Verify -> 403", async () => {
  const r = await handleReview(req({ sample_id: "s1", decision: "verify" }), base(geologist));
  assertEquals(r.status, 403);
});
Deno.test("senior geologist CAN Verify -> 200", async () => {
  let submitted = false;
  const r = await handleReview(req({ sample_id: "s1", decision: "verify", geologist_confidence: 90 }),
    base(senior, { submitReview: async (_a, p) => { submitted = true; return { status: "submitted", decision: p.decision, sample_status: "verified" }; } }));
  assertEquals(r.status, 200); assert(submitted);
  assertEquals((await r.json()).sample_status, "verified");
});
Deno.test("collector (non-reviewer) -> 403", async () => {
  const r = await handleReview(req({ sample_id: "s1", decision: "draft" }), base(collector));
  assertEquals(r.status, 403);
});
Deno.test("non-POST -> 405", async () => {
  assertEquals((await handleReview(new Request("https://x/review-sample", { method: "GET" }), base(geologist))).status, 405);
});
