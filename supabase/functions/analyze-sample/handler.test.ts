// Unit tests for the analyze-sample orchestration (mocked deps; no DB, no AI).
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { handleAnalyze, sampleSummary, type AnalyzeDeps, type LoadedSample } from "./handler.ts";
import type { SampleInput } from "../_shared/gie/types.ts";
import { UnauthorizedError } from "../_shared/enterprise/errors.ts";
import {
  buildKnowledgeProviders, buildProviders,
} from "../_shared/geocontext/providers/index.ts";

const SAMPLE: SampleInput = {
  id: "s1", name: "Milxa Quartz Vein 01", lat: 2.05, lng: 45.32, altitudeM: 12, gpsAccuracyM: 6,
  collectedAt: "2026-07-27T10:00:00Z", terrainType: "outcrop", geologicalEnvironment: "vein system", fieldObservations: "fe oxide",
  hostRock: { rockClass: "granite", texture: "coarse", weathering: "fresh", notes: null },
  minerals: [{ mineral: "quartz" }], alteration: { alterationType: "silicification", intensity: "moderate" },
  structural: [{ structureType: "vein", strikeDeg: 120, dipDeg: 70 }],
};
const LOADED: LoadedSample = { sample: SAMPLE, actorId: "owner-1", imageUrls: ["u1"], imageQuality: 0.8, inputHash: "h1", lane: "exploration" };

function base(over: Partial<AnalyzeDeps> = {}): AnalyzeDeps {
  return {
    dailyCap: 200,
    authorize: () => {},
    countToday: () => Promise.resolve(0),
    markStarted: () => Promise.resolve(),
    markFailed: () => Promise.resolve(),
    loadSample: () => Promise.resolve(LOADED),
    runProviders: () => Promise.resolve({
      contributions: [{ provider: "occurrence", category: "spatial", priority: 30, confidence: 0.6, data: {},
        datasets: [{ datasetId: "d1", source: "MRDS" }], evidence: [{ statement: "Au 300 m", weight: 0.7, tier: "mapped" }] }],
      providersRun: ["occurrence"], providersFailed: [],
    }),
    runVision: () => Promise.resolve([{ statement: "quartz veining", statementSo: "silig quartz", aspect: "vein" as const, clarity: 0.7 }]),
    runReasoning: () => Promise.resolve({
      headline: { en: "Possible gold-bearing quartz vein worth a look", so: "Silig quartz oo laga yaabo dahab" },
      simpleSummary: { en: "The photos show quartz veining that can host gold.", so: "Quartz laga yaabo dahab." },
      opportunity: "moderate" as const,
      interpretation: { whatItIs: { en: "", so: "" }, commonlyHosts: { en: "", so: "" }, lookForNext: { en: "", so: "" }, whyItMatters: { en: "", so: "" }, environment: { en: "", so: "" } },
      conclusions: [{ kind: "mineralization" as const, statement: "Possible Au quartz vein", statementSo: "Silig quartz oo dahab", isInterpretation: true,
        supporting: [{ evidenceId: "e1", contribution: 0.8 }], contradicting: [] }],
      uncertainties: [{ en: "no assay", so: "assay ma jiro" }], missingInformation: [{ en: "strike/dip", so: "" }], recommendations: [],
    }),
    saveAssessment: (_s, _a, _p) => Promise.resolve({ assessment_id: "a1", overall_confidence: 42 }),
    ...over,
  };
}
const req = (body?: unknown) => new Request("https://x/analyze-sample", { method: "POST", body: body ? JSON.stringify(body) : undefined, headers: { "content-type": "application/json" } });

Deno.test("sampleSummary summarises the geology", () => {
  assert(sampleSummary(SAMPLE).includes("host rock granite"));
  assert(sampleSummary(SAMPLE).includes("quartz"));
});

Deno.test("happy path: gathers, reasons, saves, returns counts", async () => {
  let saved = false;
  const r = await handleAnalyze(req({ sample_id: "s1" }), base({ saveAssessment: () => { saved = true; return Promise.resolve({ assessment_id: "a1" }); } }));
  assertEquals(r.status, 200);
  const b = await r.json();
  assert(saved);
  assertEquals(b.assessment_id, "a1");
  assert(b.evidence >= 1);       // field + geo + visual folded in
  assert(b.conclusions === 1);
  assertEquals(b.providers_run, ["occurrence"]);
});

Deno.test("evidence set includes field, geo and visual nodes", async () => {
  let nodeCount = 0;
  await handleAnalyze(req({ sample_id: "s1" }), base({
    runReasoning: (nodes) => { nodeCount = nodes.length; return Promise.resolve({ headline: { en: "", so: "" }, simpleSummary: { en: "", so: "" }, opportunity: "none" as const, interpretation: { whatItIs: { en: "", so: "" }, commonlyHosts: { en: "", so: "" }, lookForNext: { en: "", so: "" }, whyItMatters: { en: "", so: "" }, environment: { en: "", so: "" } }, conclusions: [], uncertainties: [], missingInformation: [], recommendations: [] }); },
  }));
  // >=1 field + 1 geo + 1 visual
  assert(nodeCount >= 3);
});

Deno.test("missing sample_id -> 400", async () => {
  const r = await handleAnalyze(req({}), base());
  assertEquals(r.status, 400);
});

Deno.test("unauthorized -> 401", async () => {
  const r = await handleAnalyze(req({ sample_id: "s1" }), base({ authorize: () => { throw new UnauthorizedError("service authorization required"); } }));
  assertEquals(r.status, 401);
});

Deno.test("sample not found -> 404", async () => {
  const r = await handleAnalyze(req({ sample_id: "zzz" }), base({ loadSample: () => Promise.resolve(null) }));
  assertEquals(r.status, 404);
});

Deno.test("daily cap reached -> skipped (no work)", async () => {
  let loaded = false;
  const r = await handleAnalyze(req({ sample_id: "s1" }), base({ countToday: () => Promise.resolve(200), loadSample: () => { loaded = true; return Promise.resolve(LOADED); } }));
  assertEquals(r.status, 200);
  assertEquals((await r.json()).skipped, "daily_cap");
  assert(!loaded);
});

// ── A failed analysis must never be silent ──────────────────────────────────
//
// Three samples submitted on 2026-08-03 sat at "submitted" indefinitely. The
// run had started and died, and nothing recorded it — so from production data
// a crashed run, a run skipped by the daily cap, and a run that was never
// triggered all looked identical. These tests pin every exit path.

Deno.test("analysis records that it STARTED, before any external call", async () => {
  const calls: string[] = [];
  await handleAnalyze(req({ sample_id: "s1" }), base({
    markStarted: (id) => { calls.push(`started:${id}`); return Promise.resolve(); },
    runVision: () => { calls.push("vision"); return Promise.resolve([]); },
    runReasoning: (n, sum) => { calls.push("reasoning"); return base().runReasoning(n, sum); },
  }));
  // Order matters: marking after the model calls would leave exactly the window
  // in which the outage happened unrecorded.
  assertEquals(calls[0], "started:s1");
});

Deno.test("reasoning failure is RECORDED against the sample, not just thrown", async () => {
  let recorded: { id: string; reason: string } | undefined;
  const res = await handleAnalyze(req({ sample_id: "s1" }), base({
    runReasoning: () => Promise.reject(new Error("Gemini API error (status 404)")),
    markFailed: (id, reason) => { recorded = { id, reason }; return Promise.resolve(); },
  }));
  assertEquals(res.status >= 400, true);
  assertEquals(recorded !== undefined, true);
  assertEquals(recorded!.id, "s1");
  // The reason has to survive to the row, or the collector learns nothing.
  assertEquals(recorded!.reason.includes("status 404"), true);
});

Deno.test("a persist failure is recorded too — the run did real work and still lost it", async () => {
  let recorded: string | undefined;
  const res = await handleAnalyze(req({ sample_id: "s1" }), base({
    saveAssessment: () => Promise.reject(new Error("save_assessment: deadlock detected")),
    markFailed: (_id, reason) => { recorded = reason; return Promise.resolve(); },
  }));
  assertEquals(res.status >= 400, true);
  assertEquals(recorded !== undefined && recorded!.includes("deadlock"), true);
});

Deno.test("the daily cap is recorded, not silently returned", async () => {
  let recorded: string | undefined;
  const res = await handleAnalyze(req({ sample_id: "s1" }), base({
    countToday: () => Promise.resolve(999),
    markFailed: (_id, reason) => { recorded = reason; return Promise.resolve(); },
  }));
  assertEquals(res.status, 200);
  // 200 with nothing written is what let a capped sample look submitted forever.
  assertEquals(recorded !== undefined, true);
  assertEquals(recorded!.toLowerCase().includes("limit"), true);
});

Deno.test("vision failure still does NOT fail the sample — it is enrichment", async () => {
  let failed = false;
  const res = await handleAnalyze(req({ sample_id: "s1" }), base({
    runVision: () => Promise.reject(new Error("payload too large")),
    markFailed: () => { failed = true; return Promise.resolve(); },
  }));
  assertEquals(res.status, 200);
  assertEquals(failed, false);
});

Deno.test("recording a failure cannot itself break the response", async () => {
  // If mark_analysis_failed is unreachable, the original error must still be
  // the one reported — a broken recorder must not mask what it was recording.
  const res = await handleAnalyze(req({ sample_id: "s1" }), base({
    runReasoning: () => Promise.reject(new Error("Gemini unavailable")),
    markFailed: () => Promise.reject(new Error("rpc down")),
  }));
  assertEquals(res.status >= 400, true);
});

// ── No started run ends in silence ───────────────────────────────────────────
//
// THE FIELD REPORT. Nine samples sat at ai_processing from one afternoon to the
// next, with no ai_error, and pressing re-analyse changed nothing.
//
// A row at ai_processing PROVES how far the run got: submit_sample inserts
// 'submitted' (0069), and only mark_analysis_started writes 'ai_processing'
// (0093). So the dispatch worked, the run began — and then it ended without
// recording anything. That is only possible on a path that throws past every
// guard, and there was one: runProviders sat after markStarted with no try/catch
// at all, while reasoning and persist below each had one. The outer catch just
// returned an HTTP error to a fire-and-forget caller that discarded it.
Deno.test("a GATHER failure is recorded — this is the path that stranded nine samples", async () => {
  let recorded: string | undefined;
  const res = await handleAnalyze(req({ sample_id: "s1" }), base({
    runProviders: () => Promise.reject(new Error("geo.macrostrat_unit: relation does not exist")),
    markFailed: (_id, reason) => { recorded = reason; return Promise.resolve(); },
  }));
  assertEquals(res.status >= 400, true);
  assertEquals(recorded !== undefined, true);
  // Gathering failing is a different diagnosis from reasoning failing, and the
  // row has to say which — otherwise the next person debugs the wrong stage.
  assertEquals(recorded!.includes("Evidence gathering failed"), true);
  assertEquals(recorded!.includes("macrostrat_unit"), true);
});

Deno.test("markStarted having run means SOMETHING is always written on failure", async () => {
  // The backstop, exercised through a stage with no guard of its own: assemble
  // is reached after markStarted and is not individually wrapped. Whatever
  // throws, a started run must not be left at ai_processing in silence.
  let recorded: string | undefined;
  const res = await handleAnalyze(req({ sample_id: "s1" }), base({
    // A provider result shaped so the pure assembly downstream throws.
    runProviders: () => Promise.resolve({
      contributions: [null as unknown as never], providersRun: ["x"], providersFailed: [],
    }),
    markFailed: (_id, reason) => { recorded = reason; return Promise.resolve(); },
  }));
  assertEquals(res.status >= 400, true);
  assertEquals(recorded !== undefined, true, "a started run ended with nothing recorded");
});

Deno.test("a run that never STARTED is not marked failed — that distinction is the point", async () => {
  // 0092 exists to separate "never triggered" from "triggered and died". A
  // sample that could not even be loaded has not started, and writing ai_failed
  // on it would destroy exactly the information the column was added to keep.
  let recorded = false;
  const res = await handleAnalyze(req({ sample_id: "missing" }), base({
    loadSample: () => Promise.resolve(null),
    markFailed: () => { recorded = true; return Promise.resolve(); },
  }));
  assertEquals(res.status, 404);
  assertEquals(recorded, false);
});

Deno.test("an unauthorized call never touches the sample", async () => {
  let recorded = false;
  const res = await handleAnalyze(req({ sample_id: "s1" }), base({
    authorize: () => { throw new Error("service authorization required"); },
    markFailed: () => { recorded = true; return Promise.resolve(); },
  }));
  assertEquals(res.status >= 400, true);
  assertEquals(recorded, false);
});

Deno.test("the backstop does not overwrite a specific diagnosis with a generic one", async () => {
  // Every stage records, then rethrows, so the outer catch runs too. If the
  // backstop wrote unconditionally it would replace "Evidence gathering failed:
  // <the actual cause>" with "Analysis failed: <same cause>" — losing WHICH
  // STAGE broke, which is the first thing anyone debugging needs.
  const written: string[] = [];
  await handleAnalyze(req({ sample_id: "s1" }), base({
    runProviders: () => Promise.reject(new Error("geo gateway timeout")),
    markFailed: (_id, reason) => { written.push(reason); return Promise.resolve(); },
  }));
  assertEquals(written.length, 1, `expected exactly one write, got: ${JSON.stringify(written)}`);
  assertEquals(written[0].startsWith("Evidence gathering failed"), true);
});

// ── A hang is a failure the sample must be TOLD about ────────────────────────
//
// The decisive evidence: twelve rows at ai_processing, ai_error null, and
// updated_at equal to ai_attempted_at to the microsecond. Not one write after
// mark_analysis_started. A thrown error cannot produce that — every throw is
// caught and recorded. Zero writes means no code ran after the run began, which
// happens when the isolate is KILLED on the wall clock with a promise pending.
//
// There were five unbounded fetches to hang on (two image reads, two Gemini
// calls). A try/catch around a promise that never settles never runs, which is
// why the earlier "vision failure is not fatal" fix did not help — it handles a
// rejection, and a hang is not one.
Deno.test("a hanging REASONING call is recorded instead of killing the run", async () => {
  let recorded: string | undefined;
  const res = await handleAnalyze(req({ sample_id: "s1" }), base({
    // Never settles — the exact shape of the production failure.
    runReasoning: () => new Promise(() => {}),
    budgets: { reasoningStage: 20 },
    markFailed: (_id, reason) => { recorded = reason; return Promise.resolve(); },
  }));
  assertEquals(res.status >= 400, true);
  assertEquals(recorded !== undefined, true, "a hang left the sample with no reason");
  assertEquals(recorded!.includes("Geological reasoning failed"), true);
  // The reason must say it was a timeout, or the next person hunts a
  // connectivity problem that was never there.
  assertEquals(/budget|timed out/i.test(recorded!), true, `reason was: ${recorded}`);
});

Deno.test("a hanging VISION call degrades the result — it does not fail the sample", async () => {
  // Vision is enrichment. The geological providers alone still yield a real
  // assessment, so a hang here must cost the visual evidence and nothing else.
  let failed = false;
  const res = await handleAnalyze(req({ sample_id: "s1" }), base({
    runVision: () => new Promise(() => {}),
    budgets: { visionStage: 20 },
    markFailed: () => { failed = true; return Promise.resolve(); },
  }));
  assertEquals(res.status, 200);
  assertEquals(failed, false, "a vision hang must not fail the sample");
});


// ── THE LANE SPLIT ──────────────────────────────────────────────────────────
//
// A personal sample is a rock somebody picked up. Running the spatial providers
// on it gave a private collection a mapped-geology reading, nearby-occurrence
// evidence and a structural context for wherever the phone happened to be — a
// statement about the ground that nobody asked for and the collector cannot
// check. These tests pin which lane gets which providers, and that the personal
// lane can never produce spatial evidence.

Deno.test("a PERSONAL sample is analysed with no spatial providers", async () => {
  let sawLane: string | null = null;
  await handleAnalyze(req({ sample_id: "s1" }), base({
    loadSample: () => Promise.resolve({ ...LOADED, lane: "personal" }),
    runProviders: (_q, lane) => {
      sawLane = lane;
      return Promise.resolve({ contributions: [], providersRun: [], providersFailed: [] });
    },
  }));
  assertEquals(sawLane, "personal");
});

Deno.test("an EXPLORATION sample gets the full engine", async () => {
  let sawLane: string | null = null;
  await handleAnalyze(req({ sample_id: "s1" }), base({
    loadSample: () => Promise.resolve({ ...LOADED, lane: "exploration" }),
    runProviders: (_q, lane) => {
      sawLane = lane;
      return Promise.resolve({ contributions: [], providersRun: [], providersFailed: [] });
    },
  }));
  assertEquals(sawLane, "exploration");
});

Deno.test("the knowledge lane holds exactly the providers that read the SPECIMEN", () => {
  // Named individually rather than counted: a provider added to the full set must
  // be a deliberate decision about which lane it belongs to, and a count would
  // wave that through.
  const gw = {} as never;
  const knowledge = buildKnowledgeProviders(gw).map((p) => p.name).sort();
  const full = buildProviders(gw).map((p) => p.name).sort();

  for (const spatial of ["geology", "occurrence", "structural_geology", "community"]) {
    assertEquals(knowledge.includes(spatial), false, `${spatial} must not be in the personal lane`);
    assertEquals(full.includes(spatial), true, `${spatial} must stay in the full engine`);
  }
  // And the full engine is untouched: every knowledge provider is still in it.
  for (const k of knowledge) assertEquals(full.includes(k), true, `${k} missing from the full engine`);
});
