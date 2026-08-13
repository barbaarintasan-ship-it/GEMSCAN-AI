// analyze-mission, driven with fabricated credentials and a fake R2.
//
//   deno test --allow-net=deno.land supabase/functions/analyze-mission/handler.test.ts
//
// The rules being pinned here are the ones that protect a geologist's day of work:
//
//   • one missing photograph means the model is NEVER called
//   • R2 being unreachable is not the same as a photograph being absent
//   • storage is HEADed once per run, not twice
//   • a failed analysis leaves the evidence exactly where it was
//   • the engine's prospectivity score passes through untouched
//
// None of it needs real credentials or a real model.
import {
  assertEquals, assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  checkStorage, engineSummaryFrom, handleAnalyzeMission, isServiceRole,
  photoDescriptionsFrom, roleClaimOf, runAnalysis,
  type AnalyzeMissionDeps, type StoredPackage,
} from "./handler.ts";
import type { Actor } from "../_shared/enterprise/auth.ts";
import { ForbiddenError } from "../_shared/enterprise/errors.ts";

const ALICE = { userId: "11111111-1111-1111-1111-111111111111" } as Actor;
const CONFIG = {
  accountId: "acct123", accessKeyId: "AKIAFAKE",
  secretAccessKey: "not-a-real-secret", bucket: "evidence",
};

const MISSION = "ms-abc";

function pkg(over: Partial<StoredPackage> = {}): StoredPackage {
  return {
    packageId: "ms-abc",
    missionId: MISSION,
    filesVerifiedAt: null,
    payload: {
      missionId: MISSION,
      targetCell: "87abc",
      targetCentre: { lat: 9.52, lng: 43.13 },
      commodity: "gold",
      prospectivityScore: 0.42,
      geologyContext: "Late Cretaceous sedimentary",
      terrainContext: "slope",
      targetReasons: [{ kind: "fault_proximity" }],
      track: [{ lat: 9.5, lng: 43.1 }, { lat: 9.51, lng: 43.11 }],
      observations: [{
        type: "gossan",
        notes: "iron staining on a broken face",
        positionQuality: "good",
        position: { lat: 9.52, lng: 43.13, accuracyM: 6 },
        photos: [{ id: "p1" }, { id: "p2" }],
      }],
    },
    ...over,
  };
}

/** Findings the parser will accept, so "analysed" is reachable in tests. */
const MODEL_JSON = JSON.stringify({
  interest: "worth_following_up",
  confidence: "low",
  evidence: [{
    type: "gossan", origin: "field_observation", status: "present",
    strength: "moderate", confidence: "low", significance: "oxidised_sulphides",
  }],
  missingEvidence: ["assay", "geochemistry"],
  recommendations: [{ action: "collect_rock_samples", priority: 1, becauseOf: ["gossan"] }],
});

function deps(over: Partial<AnalyzeMissionDeps> = {}): AnalyzeMissionDeps {
  return {
    resolveActor: async () => ALICE,
    requireEnterprise: async () => {},
    isOperator: () => false,
    loadPackage: async () => pkg(),
    markVerified: async (_a, _m, v) => v.length,
    // Both photographs present and a plausible size.
    verify: async (_c, keys) =>
      keys.map((k) => ({ key: k, exists: true, bytes: 200_000, status: 200 })),
    provider: () => ({ model: "test-model", generate: async () => MODEL_JSON }),
    config: () => ({ config: CONFIG }),
    now: () => 1_760_000_000_000,
    loadReport: async () => null,
    savePhotoDescriptions: async (_a, _m, d) => d.length,
    saveReport: async () => "report-1",
    failAnalysis: async () => 1,
    ...over,
  };
}

function post(body: unknown): Request {
  return new Request("https://x.functions.supabase.co/analyze-mission", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ── THE GATE ────────────────────────────────────────────────────────────────

Deno.test("THE GATE: one missing photograph and the model is never called", async () => {
  let modelCalled = false;
  const res = await handleAnalyzeMission(post({ missionId: MISSION }), deps({
    verify: async (_c, keys) => keys.map((k, i) => ({
      key: k, exists: i === 0, bytes: i === 0 ? 200_000 : null, status: i === 0 ? 200 : 404,
    })),
    provider: () => ({
      model: "test-model",
      generate: async () => { modelCalled = true; return MODEL_JSON; },
    }),
  }));

  assertEquals(res.status, 409);
  assertEquals(modelCalled, false);
  const body = await res.json();
  assertEquals(body.status, "blocked");
  assertEquals(body.missing.length, 1);
  assertEquals(body.missing[0].id, "p2");
});

Deno.test("a zero-byte object is not a photograph, and blocks too", async () => {
  const res = await handleAnalyzeMission(post({ missionId: MISSION }), deps({
    verify: async (_c, keys) => keys.map((k, i) => ({
      key: k, exists: true, bytes: i === 0 ? 200_000 : 0, status: 200,
    })),
  }));
  assertEquals(res.status, 409);
  assertStringIncludes(JSON.stringify((await res.json()).missing), "too small");
});

Deno.test("what DID arrive is recorded even when the set is incomplete", async () => {
  // A photograph verified once should never have to be checked again, so the
  // partial result is written before the completeness test decides to stop.
  let marked: string[] = [];
  const out = await runAnalysis(ALICE, MISSION, deps({
    verify: async (_c, keys) => keys.map((k, i) => ({
      key: k, exists: i === 0, bytes: i === 0 ? 200_000 : null, status: i === 0 ? 200 : 404,
    })),
    markVerified: async (_a, _m, v) => { marked = v.map((x) => x.id); return v.length; },
  }));
  assertEquals(marked, ["p1"]);
  assertEquals(out.outcome.status, "blocked");
});

Deno.test("STORAGE UNREACHABLE is not 'the photographs are missing'", async () => {
  // Failing a mission because the network blinked would destroy real work. The
  // distinction is the whole reason verifyObjects throws instead of returning
  // absence.
  let marked = false;
  const res = await handleAnalyzeMission(post({ missionId: MISSION }), deps({
    verify: async () => { throw new Error("connection reset"); },
    markVerified: async () => { marked = true; return 0; },
  }));
  // Not 409 — nothing has been shown to be absent.
  assertEquals(res.status !== 409, true);
  assertEquals(marked, false);
});

Deno.test("storage NOT CONFIGURED is 503, and nothing is recorded against the mission", async () => {
  const res = await handleAnalyzeMission(post({ missionId: MISSION }), deps({
    config: () => ({ missing: ["R2_SECRET_ACCESS_KEY"] }),
  }));
  assertEquals(res.status, 503);
  assertStringIncludes((await res.json()).detail, "R2_SECRET_ACCESS_KEY");
});

// ── EFFICIENCY THE GATE DEPENDS ON ──────────────────────────────────────────

Deno.test("every object is HEADed ONCE per run, not twice", async () => {
  // analyzeExplorationPackage verifies too. Handing it the results already
  // collected is what stops a thirty-photograph mission paying for sixty round
  // trips — and stops the two passes ever disagreeing.
  let calls = 0;
  await runAnalysis(ALICE, MISSION, deps({
    verify: async (_c, keys) => {
      calls++;
      return keys.map((k) => ({ key: k, exists: true, bytes: 200_000, status: 200 }));
    },
  }));
  assertEquals(calls, 1);
});

// ── OWNERSHIP ───────────────────────────────────────────────────────────────

Deno.test("a mission belonging to somebody else is not found", async () => {
  const res = await handleAnalyzeMission(post({ missionId: MISSION }), deps({
    loadPackage: async () => null,
  }));
  assertEquals(res.status, 404);
});

Deno.test("a non-enterprise account is refused before anything is read", async () => {
  let loaded = false;
  const res = await handleAnalyzeMission(post({ missionId: MISSION }), deps({
    requireEnterprise: async () => { throw new ForbiddenError("not enabled"); },
    loadPackage: async () => { loaded = true; return pkg(); },
  }));
  assertEquals(res.status, 403);
  assertEquals(loaded, false);
});

// ── THE ASSESSMENT ──────────────────────────────────────────────────────────

Deno.test("a complete set is assessed, and the findings come back", async () => {
  const res = await handleAnalyzeMission(post({ missionId: MISSION }), deps());
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.status, "analysed");
  assertEquals(body.outcome.findings.model, "test-model");
});

Deno.test("a model failure leaves the evidence untouched and is retryable", async () => {
  const out = await runAnalysis(ALICE, MISSION, deps({
    provider: () => ({
      model: "test-model",
      generate: async () => { throw new Error("model unavailable"); },
    }),
  }));
  assertEquals(out.outcome.status, "failed");
  // The verification still stands: the photographs are in storage either way.
  assertEquals(out.verification?.complete, true);
});

Deno.test("a package with NO photographs is analysable — that is a real finding", async () => {
  const empty = pkg();
  (empty.payload as any).observations = [{
    type: "outcrop", notes: "no camera", positionQuality: "good", photos: [],
  }];
  const out = await runAnalysis(ALICE, MISSION, deps({ loadPackage: async () => empty }));
  assertEquals(out.outcome.status, "analysed");
  assertEquals(out.verification, null);
});

// ── THE ENGINE'S NUMBERS ────────────────────────────────────────────────────

Deno.test("the prospectivity score passes through UNTOUCHED", async () => {
  // The engine computed it when the target was offered; it is what the geologist
  // was told. Nothing in the interpretation layer may recompute it.
  const s = engineSummaryFrom(pkg());
  assertEquals(s.prospectivityScore, 0.42);
  assertEquals(s.targetCell, "87abc");
  assertEquals(s.commodity, "gold");
});

Deno.test("readings the package does not carry are NULL, never zero", async () => {
  // The prompt renders null as NOT AVAILABLE, which is deliberately different
  // from a measurement that came back as nothing.
  const s = engineSummaryFrom(pkg());
  assertEquals(s.elevationM, null);
  assertEquals(s.faultDistanceM, null);
  assertEquals(s.contactDistanceM, null);
  assertEquals(s.drainageDistanceM, null);
});

Deno.test("observations and photo counts are summarised from the package itself", async () => {
  const s = engineSummaryFrom(pkg());
  assertEquals(s.observations.length, 1);
  assertEquals(s.observations[0].type, "gossan");
  assertEquals(s.photoCount, 2);
  assertEquals(s.trackPoints, 2);
  assertEquals(s.gpsAccuracyM, 6);
});

// ── HEALTH ──────────────────────────────────────────────────────────────────

Deno.test("health: a 404 from R2 is a PASS — the signature was accepted", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (async () => new Response(null, { status: 404 })) as typeof fetch;
  try {
    const r = await checkStorage(deps());
    assertEquals(r.ok, true);
  } finally { globalThis.fetch = real; }
});

Deno.test("health: a 403 is a FAIL, and names the likely causes in order", async () => {
  // Presigning is local arithmetic and proves nothing. This is the only thing in
  // the system that proves the credentials actually work.
  const real = globalThis.fetch;
  globalThis.fetch = (async () => new Response(null, { status: 403 })) as typeof fetch;
  try {
    const r = await checkStorage(deps());
    assertEquals(r.ok, false);
    assertEquals(r.status, 403);
    // Ordered by how often each is actually the cause, not alphabetically.
    assertStringIncludes(r.detail, "scoped to a different bucket");
    assertStringIncludes(r.detail, "Account API token");
  } finally { globalThis.fetch = real; }
});

Deno.test("health: unconfigured storage names the missing variables", async () => {
  const r = await checkStorage(deps({ config: () => ({ missing: ["R2_BUCKET_NAME"] }) }));
  assertEquals(r.ok, false);
  assertStringIncludes(r.detail, "R2_BUCKET_NAME");
});

Deno.test("health: the OPERATOR may ask, without a user session", async () => {
  // A health check reachable only from a signed-in phone is not much of a health
  // check. This is the route an operator hits from a terminal when something is
  // wrong, and the service role is who they are.
  const real = globalThis.fetch;
  globalThis.fetch = (async () => new Response(null, { status: 404 })) as typeof fetch;
  try {
    let resolved = false;
    const res = await handleAnalyzeMission(
      new Request("https://x.functions.supabase.co/analyze-mission/health"),
      deps({
        isOperator: () => true,
        resolveActor: async () => { resolved = true; return ALICE; },
      }),
    );
    assertEquals(res.status, 200);
    assertEquals((await res.json()).as, "operator");
    // Answered before resolveActor: the service role is not a user and
    // auth.getUser() would reject it.
    assertEquals(resolved, false);
  } finally { globalThis.fetch = real; }
});

Deno.test("the operator branch is /health ONLY — it opens no other route", async () => {
  // If this ever let an analysis through, the service role would be able to read
  // any geologist's mission. The branch is one method, one path, and no row.
  const res = await handleAnalyzeMission(post({ missionId: MISSION }), deps({
    isOperator: () => true,
    resolveActor: async () => { throw new Error("no user session"); },
  }));
  assertEquals(res.status >= 400, true);
});

Deno.test("no service-role key configured means NOBODY is the operator", async () => {
  // The dangerous default is "everybody". realDeps returns false when the key is
  // absent; this pins the intent.
  const res = await handleAnalyzeMission(
    new Request("https://x.functions.supabase.co/analyze-mission/health"),
    deps({ isOperator: () => false, requireEnterprise: async () => {
      throw new ForbiddenError("not enabled");
    } }),
  );
  assertEquals(res.status, 403);
});

// ── WHO THE OPERATOR IS ─────────────────────────────────────────────────────

/** A JWT with the given role. Unsigned — the gateway is what checks signatures. */
function jwt(role: string): string {
  const b64 = (o: unknown) =>
    btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ iss: "supabase", role })}.sig`;
}

Deno.test("the injected key matches exactly, when it matches at all", () => {
  assertEquals(isServiceRole("Bearer abc123", "abc123"), true);
  assertEquals(isServiceRole("Bearer abc123", "different"), false);
});

Deno.test("a service_role token is accepted even when the injected key has drifted", () => {
  // The failure this exists for: after a JWT key rotation the dashboard's key and
  // the function's injected key are two different strings, and a perfectly valid
  // service-role token was refused with nothing to explain why.
  assertEquals(isServiceRole(`Bearer ${jwt("service_role")}`, "a-stale-key"), true);
  assertEquals(isServiceRole(`Bearer ${jwt("service_role")}`, undefined), true);
});

Deno.test("anon is NOT the operator", () => {
  // Both keys sit on the same dashboard tab and both begin `eyJ`. The role claim
  // is the only thing that tells them apart.
  assertEquals(isServiceRole(`Bearer ${jwt("anon")}`, "a-stale-key"), false);
  assertEquals(isServiceRole(`Bearer ${jwt("authenticated")}`, undefined), false);
});

Deno.test("junk is not the operator, and does not throw", () => {
  // This decides an auth branch. An exception here would be a 500 where a plain
  // "no" belongs.
  for (const h of [null, "", "Bearer", "Bearer not.a.jwt", "Basic abc", "Bearer a.b", "abc"]) {
    assertEquals(isServiceRole(h, undefined), false, `header ${JSON.stringify(h)}`);
  }
});

Deno.test("roleClaimOf reads the claim, and only the claim", () => {
  assertEquals(roleClaimOf(jwt("service_role")), "service_role");
  assertEquals(roleClaimOf(jwt("anon")), "anon");
  assertEquals(roleClaimOf("garbage"), null);
});

Deno.test("health reports WHAT IT SIGNED WITH, and never the secret", async () => {
  // "Check your three variables" is a list of worries, not a diagnosis. The
  // bucket and host let an operator hold this beside Cloudflare and see the
  // difference at a glance.
  const real = globalThis.fetch;
  globalThis.fetch = (async () => new Response(null, { status: 403 })) as typeof fetch;
  try {
    const r = await checkStorage(deps());
    assertEquals(r.ok, false);
    assertEquals(r.using?.bucket, "evidence");
    assertEquals(r.using?.host, "acct123.r2.cloudflarestorage.com");
    assertEquals(r.using?.accessKeyIdPrefix, "AKIAFA");
    // The secret never appears, in any field, in any form.
    const dumped = JSON.stringify(r);
    assertEquals(dumped.includes(CONFIG.secretAccessKey), false);
    assertEquals(dumped.includes(CONFIG.accessKeyId), false);
  } finally { globalThis.fetch = real; }
});

Deno.test("a 404 from R2 on the probe is a PASS and still reports the config", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (async () => new Response(null, { status: 404 })) as typeof fetch;
  try {
    const r = await checkStorage(deps());
    assertEquals(r.ok, true);
    assertEquals(r.using?.bucket, "evidence");
  } finally { globalThis.fetch = real; }
});

Deno.test("health reports the secret's SHAPE, and not one character of it", async () => {
  // Invisible whitespace on a pasted secret produces SignatureDoesNotMatch, which
  // R2 returns as a bare 403 — indistinguishable from wrong credentials, wrong
  // bucket and wrong account. A length and a boolean settle it in one request.
  const real = globalThis.fetch;
  globalThis.fetch = (async () => new Response(null, { status: 403 })) as typeof fetch;
  try {
    const dirty = { ...CONFIG, secretAccessKey: "a".repeat(64) + "\n" };
    const r = await checkStorage(deps({ config: () => ({ config: dirty }) }));
    assertEquals(r.using?.secretLength, 65);
    assertEquals(r.using?.secretHasWhitespace, true);
    // Not one character of the secret, in any field.
    assertEquals(JSON.stringify(r).includes(dirty.secretAccessKey.trim()), false);
  } finally { globalThis.fetch = real; }
});

Deno.test("a clean 64-char hex secret reports as clean", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (async () => new Response(null, { status: 404 })) as typeof fetch;
  try {
    const clean = { ...CONFIG, secretAccessKey: "0123456789abcdef".repeat(4) };
    const r = await checkStorage(deps({ config: () => ({ config: clean }) }));
    assertEquals(r.using?.secretLength, 64);
    assertEquals(r.using?.secretLooksHex, true);
    assertEquals(r.using?.secretHasWhitespace, false);
  } finally { globalThis.fetch = real; }
});

// ── PERSISTENCE ─────────────────────────────────────────────────────────────

Deno.test("findings are SAVED, and the report id comes back", async () => {
  let saved: { mission: string; pkg: string; model: string } | null = null;
  const res = await handleAnalyzeMission(post({ missionId: MISSION }), deps({
    saveReport: async (_a, m, p, f) => {
      saved = { mission: m, pkg: p, model: f.model };
      return "report-42";
    },
  }));
  assertEquals(res.status, 200);
  assertEquals((await res.json()).reportId, "report-42");
  assertEquals(saved!.mission, MISSION);
  assertEquals(saved!.pkg, "ms-abc");
  assertEquals(saved!.model, "test-model");
});

Deno.test("a BLOCKED mission writes NOTHING — waiting is not failing", async () => {
  // The photographs are still arriving. Recording that as a failure would make a
  // mission look broken minutes before it completes on its own.
  let saved = false, failed = false;
  const res = await handleAnalyzeMission(post({ missionId: MISSION }), deps({
    verify: async (_c, keys) => keys.map((k, i) => ({
      key: k, exists: i === 0, bytes: i === 0 ? 200_000 : null, status: i === 0 ? 200 : 404,
    })),
    saveReport: async () => { saved = true; return "x"; },
    failAnalysis: async () => { failed = true; return 1; },
  }));
  assertEquals(res.status, 409);
  assertEquals(saved, false);
  assertEquals(failed, false);
});

Deno.test("a model failure is RECORDED against the mission, with the reason", async () => {
  let reason = "";
  await runAnalysis(ALICE, MISSION, deps({
    provider: () => ({
      model: "test-model",
      generate: async () => { throw new Error("model unavailable"); },
    }),
    failAnalysis: async (_a, _m, r) => { reason = r; return 1; },
  }));
  assertStringIncludes(reason, "provider_error");
  assertStringIncludes(reason, "model unavailable");
});

Deno.test("a package that can never be analysed is recorded, not retried for ever", async () => {
  // The refusal path, reached the only way it actually can be: a stored row whose
  // mission_id is empty. `engineSummaryFrom` takes the id from the DB column, not
  // from the payload, so a malformed payload alone cannot produce this — which is
  // worth knowing, because it means `refused` is a guard rather than a live branch.
  let reason = "";
  const out = await runAnalysis(ALICE, MISSION, deps({
    loadPackage: async () => ({ ...pkg(), missionId: "", payload: { observations: [] } }),
    failAnalysis: async (_a, _m, r) => { reason = r; return 1; },
  }));
  assertEquals(out.outcome.status, "refused");
  assertStringIncludes(reason, "package_incomplete");
});

Deno.test("storage being unconfigured is NOT held against the mission", async () => {
  // An operator's missing secret is not a geologist's problem. Nothing is written.
  let failed = false;
  const res = await handleAnalyzeMission(post({ missionId: MISSION }), deps({
    config: () => ({ missing: ["R2_BUCKET_NAME"] }),
    failAnalysis: async () => { failed = true; return 1; },
  }));
  assertEquals(res.status, 503);
  assertEquals(failed, false);
});

// ── IDEMPOTENCE ─────────────────────────────────────────────────────────────

Deno.test("an existing report is COLLECTED, not re-analysed", async () => {
  // The device polls, and it must — an analysis triggered before the signal went
  // is collected after it comes back. Re-running the model on every poll would be
  // a bill per poll, and two readings of one mission free to disagree.
  let modelCalled = false, verified = false;
  const findings = { confidence: "low", model: "earlier-model" } as never;
  const res = await handleAnalyzeMission(post({ missionId: MISSION }), deps({
    loadReport: async () => ({ reportId: "report-earlier", findings }),
    provider: () => ({
      model: "test-model",
      generate: async () => { modelCalled = true; return MODEL_JSON; },
    }),
    verify: async (_c, keys) => {
      verified = true;
      return keys.map((k) => ({ key: k, exists: true, bytes: 200_000, status: 200 }));
    },
  }));

  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.reportId, "report-earlier");
  assertEquals(body.outcome.findings.model, "earlier-model");
  assertEquals(modelCalled, false);
  // Not even the HEADs: the photographs were verified when the report was written.
  assertEquals(verified, false);
});

Deno.test("force re-reads, and that is the ONLY way past the cache", async () => {
  let modelCalled = false;
  const res = await handleAnalyzeMission(
    post({ missionId: MISSION, force: true }),
    deps({
      loadReport: async () => ({
        reportId: "old", findings: { confidence: "low", model: "old" } as never,
      }),
      provider: () => ({
        model: "test-model",
        generate: async () => { modelCalled = true; return MODEL_JSON; },
      }),
    }),
  );
  assertEquals(res.status, 200);
  assertEquals(modelCalled, true);
  assertEquals((await res.json()).outcome.findings.model, "test-model");
});

Deno.test("a mission with no report yet still analyses normally", async () => {
  let modelCalled = false;
  await runAnalysis(ALICE, MISSION, deps({
    loadReport: async () => null,
    savePhotoDescriptions: async (_a, _m, d) => d.length,
    provider: () => ({
      model: "test-model",
      generate: async () => { modelCalled = true; return MODEL_JSON; },
    }),
  }));
  assertEquals(modelCalled, true);
});

// ── THE ENGINE'S READINGS ───────────────────────────────────────────────────

Deno.test("engine readings carried by a v2 package reach the prompt", async () => {
  // The defect: the package carried none of these, so the server passed null for
  // all four, the prompt rendered NOT AVAILABLE, and the model reported them as
  // evidence NOBODY HAD LOOKED AT — when the engine had measured every one before
  // it offered the target.
  const withReadings = pkg();
  (withReadings.payload as any).engineReadings = {
    elevationM: 1729, faultDistanceM: 21060,
    contactDistanceM: 26780, drainageDistanceM: 2620,
  };
  const s = engineSummaryFrom(withReadings);
  assertEquals(s.elevationM, 1729);
  assertEquals(s.faultDistanceM, 21060);
  assertEquals(s.contactDistanceM, 26780);
  assertEquals(s.drainageDistanceM, 2620);
});

Deno.test("a v1 package still reports NOT AVAILABLE, and that is accurate for it", async () => {
  const s = engineSummaryFrom(pkg());   // no engineReadings at all
  assertEquals(s.elevationM, null);
  assertEquals(s.faultDistanceM, null);
});

Deno.test("a reading of ZERO is a reading, not an absence", async () => {
  // Standing on a fault is 0 m from it. Coercing that to null would turn the
  // strongest possible structural reading into "never measured".
  const onFault = pkg();
  (onFault.payload as any).engineReadings = {
    elevationM: 0, faultDistanceM: 0, contactDistanceM: null, drainageDistanceM: null,
  };
  const s = engineSummaryFrom(onFault);
  assertEquals(s.elevationM, 0);
  assertEquals(s.faultDistanceM, 0);
  assertEquals(s.contactDistanceM, null);
});

// ── WHAT THE MODEL READ FROM EACH PHOTOGRAPH ────────────────────────────────

Deno.test("only PHOTOGRAPH evidence produces a description", async () => {
  // An engine layer carrying a photo id is the model having misunderstood the
  // question, not a fact about an image. Writing it would put a map reading in
  // the caption slot of a photograph nobody took it from.
  const findings = {
    evidence: [
      { type: "iron_staining", origin: "photograph", photoId: "p1", significance: "surface_alteration" },
      { type: "fault_proximity", origin: "engine_layer", photoId: "p1", significance: "structural_control" },
      { type: "gossan", origin: "field_observation", significance: "oxidised_sulphides" },
    ],
  } as never;
  const out = photoDescriptionsFrom(findings);
  assertEquals(out.length, 1);
  assertEquals(out[0].id, "p1");
  assertStringIncludes(out[0].description, "iron_staining");
  assertEquals(out[0].description.includes("fault_proximity"), false);
});

Deno.test("two readings of ONE photograph are one description", async () => {
  const findings = {
    evidence: [
      { type: "iron_staining", origin: "photograph", photoId: "p1", significance: "surface_alteration" },
      { type: "quartz_vein", origin: "photograph", photoId: "p1", significance: "pathfinder" },
      { type: "boxwork", origin: "photograph", photoId: "p2", significance: "leached_sulphides" },
    ],
  } as never;
  const out = photoDescriptionsFrom(findings);
  assertEquals(out.length, 2);
  assertStringIncludes(out.find((x) => x.id === "p1")!.description, "iron_staining");
  assertStringIncludes(out.find((x) => x.id === "p1")!.description, "quartz_vein");
});

Deno.test("a failed description does NOT lose the report", async () => {
  // The assessment is the thing that matters. A caption that did not save is a
  // missing sentence, not a missing reading.
  let saved = false;
  const res = await handleAnalyzeMission(post({ missionId: MISSION }), deps({
    savePhotoDescriptions: async () => { throw new Error("db busy"); },
    saveReport: async () => { saved = true; return "report-1"; },
  }));
  assertEquals(res.status, 200);
  assertEquals(saved, true);
});

Deno.test("photo ids reach the prompt, so a reading can cite one", async () => {
  const s = engineSummaryFrom(pkg());
  assertEquals(s.observations[0].photoIds, ["p1", "p2"]);
});
