// Unit tests for the enterprise-mission-synthesis handler (mocked deps; no DB/stack).
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildSynthesisPrompt, type Deps, handleMissionSynthesis, parseSynthesisResponse, type SynthesisContext } from "./handler.ts";
import type { Actor } from "../_shared/enterprise/auth.ts";
import { ForbiddenError } from "../_shared/enterprise/errors.ts";

const MANAGER: Actor = { userId: "mgr-1", email: "owner@example.com", contributorId: null, role: null };

const CTX: SynthesisContext = {
  mission_id: "m1",
  target_h3: "877a1c285ffffff",
  deterministic_score: 0.62,
  score_engine_version: "gie-1.4",
  contributor_count: 2,
  sample_count: 2,
  contributors: [
    { contributor_label: "Contributor A", sample_id: "s1", rock_class: "granite" },
    { contributor_label: "Contributor B", sample_id: "s2", rock_class: "quartz vein" },
  ],
};

function base(over: Partial<Deps> = {}): Deps {
  return {
    resolveActor: async () => MANAGER,
    requireEnterprise: async () => {},
    getContext: async () => CTX,
    callClaude: async () => ({
      headline: "Two contributors agree on a quartz-hosted system.",
      headline_so: "Laba wax-ka-qeybgale ayaa ku raacsan nidaam quartz ah.",
      narrative: "Both samples describe similar host rock.",
      narrative_so: "Labada muunadba waxay sharraxaan dhagax martida ah oo isku mid ah.",
      agreement: "consistent",
      discardedKeys: [],
    }),
    saveSynthesis: async () => ({ id: "syn-1" }),
    getSaved: async () => ({ id: "syn-1", headline: "saved" }),
    ...over,
  };
}
function req(method: string, body?: unknown, path = "https://x/enterprise-mission-synthesis") {
  return new Request(path, { method, body: body ? JSON.stringify(body) : undefined, headers: { "content-type": "application/json" } });
}

Deno.test("POST generates and saves a synthesis, returning the result", async () => {
  const res = await handleMissionSynthesis(req("POST", { missionId: "m1", targetH3: "877a1c285ffffff" }), base());
  assertEquals(res.status, 201);
  const body = await res.json();
  assertEquals(body.id, "syn-1");
  assertEquals(body.agreement, "consistent");
  assertEquals(body.contributor_count, 2);
});

Deno.test("POST rejects a cell with zero samples", async () => {
  const res = await handleMissionSynthesis(
    req("POST", { missionId: "m1", targetH3: "empty" }),
    base({ getContext: async () => ({ ...CTX, sample_count: 0, contributor_count: 0, contributors: [] }) }),
  );
  assertEquals(res.status, 400);
});

Deno.test("POST requires missionId and targetH3", async () => {
  const res = await handleMissionSynthesis(req("POST", { missionId: "m1" }), base());
  assertEquals(res.status, 400);
});

Deno.test("POST surfaces the RPC's forbidden error as 403", async () => {
  const res = await handleMissionSynthesis(
    req("POST", { missionId: "m1", targetH3: "877a1c285ffffff" }),
    base({ getContext: async () => { throw new ForbiddenError("only a mission manager can request cross-contributor synthesis"); } }),
  );
  assertEquals(res.status, 403);
});

Deno.test("GET returns the saved synthesis", async () => {
  const res = await handleMissionSynthesis(
    req("GET", undefined, "https://x/enterprise-mission-synthesis?missionId=m1&targetH3=877a1c285ffffff"),
    base(),
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.id, "syn-1");
});

Deno.test("GET 404s when nothing has been generated yet", async () => {
  const res = await handleMissionSynthesis(
    req("GET", undefined, "https://x/enterprise-mission-synthesis?missionId=m1&targetH3=none"),
    base({ getSaved: async () => null }),
  );
  assertEquals(res.status, 404);
});

Deno.test("GET requires both query params", async () => {
  const res = await handleMissionSynthesis(
    req("GET", undefined, "https://x/enterprise-mission-synthesis?missionId=m1"),
    base(),
  );
  assertEquals(res.status, 400);
});

Deno.test("requireEnterprise gate is enforced before any DB/AI call happens", async () => {
  let getContextCalled = false;
  const res = await handleMissionSynthesis(
    req("POST", { missionId: "m1", targetH3: "877a1c285ffffff" }),
    base({
      requireEnterprise: async () => { throw new ForbiddenError("enterprise access is not enabled for this account"); },
      getContext: async () => { getContextCalled = true; return CTX; },
    }),
  );
  assertEquals(res.status, 403);
  assertEquals(getContextCalled, false);
});

// ── Prompt / parsing — the AI-safety firewall ──────────────────────────────

Deno.test("[firewall] buildSynthesisPrompt explicitly forbids probability/score language", () => {
  const prompt = buildSynthesisPrompt(CTX);
  assert(/NEVER state a probability/i.test(prompt));
  assert(prompt.includes(CTX.target_h3));
});

Deno.test("[firewall] parseSynthesisResponse strips score-like keys the model might still emit", () => {
  const raw = JSON.stringify({
    headline: "H", headline_so: "H-so", narrative: "N", narrative_so: "N-so", agreement: "mixed",
    prospectivity_score: 0.9, confidence: 87, probability: "high", chance_of_gold: "likely",
  });
  const result = parseSynthesisResponse(raw);
  assertEquals(result.headline, "H");
  assertEquals(result.agreement, "mixed");
  assert(result.discardedKeys.includes("prospectivity_score"));
  assert(result.discardedKeys.includes("confidence"));
  assert(result.discardedKeys.includes("probability"));
  assert(result.discardedKeys.includes("chance_of_gold"));
});

Deno.test("[firewall] parseSynthesisResponse falls back to insufficient_data on an invalid agreement value", () => {
  const raw = JSON.stringify({ headline: "H", narrative: "N", agreement: "definitely gold" });
  const result = parseSynthesisResponse(raw);
  assertEquals(result.agreement, "insufficient_data");
});

Deno.test("[firewall] parseSynthesisResponse strips a code fence if the model adds one anyway", () => {
  const raw = "```json\n" + JSON.stringify({ headline: "H", narrative: "N", agreement: "consistent" }) + "\n```";
  const result = parseSynthesisResponse(raw);
  assertEquals(result.headline, "H");
  assertEquals(result.agreement, "consistent");
});
