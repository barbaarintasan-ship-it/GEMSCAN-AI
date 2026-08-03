// Unit tests for the analyze-sample orchestration (mocked deps; no DB, no AI).
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { handleAnalyze, sampleSummary, type AnalyzeDeps, type LoadedSample } from "./handler.ts";
import type { SampleInput } from "../_shared/gie/types.ts";
import { UnauthorizedError } from "../_shared/enterprise/errors.ts";

const SAMPLE: SampleInput = {
  id: "s1", name: "Milxa Quartz Vein 01", lat: 2.05, lng: 45.32, altitudeM: 12, gpsAccuracyM: 6,
  collectedAt: "2026-07-27T10:00:00Z", terrainType: "outcrop", geologicalEnvironment: "vein system", fieldObservations: "fe oxide",
  hostRock: { rockClass: "granite", texture: "coarse", weathering: "fresh", notes: null },
  minerals: [{ mineral: "quartz" }], alteration: { alterationType: "silicification", intensity: "moderate" },
  structural: [{ structureType: "vein", strikeDeg: 120, dipDeg: 70 }],
};
const LOADED: LoadedSample = { sample: SAMPLE, actorId: "owner-1", imageUrls: ["u1"], imageQuality: 0.8, inputHash: "h1" };

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
