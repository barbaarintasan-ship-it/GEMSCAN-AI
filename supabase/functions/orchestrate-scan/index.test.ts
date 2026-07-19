// Integration tests for the Stage 4-7 orchestration flow in index.ts:
// provider fan-out, per-provider error isolation, entitlement-gated provider
// exclusion, persistence of raw responses + ranked candidates, and the final
// response shape returned to the mobile app.
//
// These exercise `processScan` directly with a mocked Supabase client and
// mocked `VisionProvider`s (never real AI vendor APIs or a real database),
// which is the seam `processScan` was given a `providers` override for.
//
// Run with: deno test --allow-env supabase/functions/orchestrate-scan/index.test.ts
// (--allow-env is needed only because importing the real providerRegistry
// transitively imports provider adapters that read optional model-name env
// vars at module load time, e.g. GEMINI_MODEL — no env values are read by
// the test logic itself.)
import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { processScan } from "./index.ts";
import { INSUFFICIENT_CONFIDENCE_MESSAGE } from "./ensemble.ts";
import type { ProviderInput, ProviderResult, VisionProvider } from "./providers/types.ts";
// deno-lint-ignore no-explicit-any
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

function mockProvider(
  overrides: Partial<VisionProvider> & { name: string },
): VisionProvider {
  return {
    baseWeight: 1,
    isApplicable: () => true,
    identify: async () => ({
      provider: overrides.name,
      candidate: null,
      alternatives: [],
      reasoning: "",
      latencyMs: 1,
    }),
    ...overrides,
  };
}

function createMockServiceClient() {
  const inserted: Record<string, unknown[]> = {};
  const updates: Record<string, unknown[]> = {};
  let signedUrlError: string | null = null;

  const deletes: Record<string, number> = {};
  // Distinct from `inserted[table].length` (total ROWS): this counts how many
  // separate `.insert()` CALLS happened, so tests can tell "one bulk insert of
  // N rows" apart from "N separate inserts of one row each" (the progressive-
  // results behavior — see the "persists progressively" test below).
  const insertCalls: Record<string, number> = {};

  // deno-lint-ignore no-explicit-any
  function makeQueryBuilder(table: string): any {
    return {
      update(payload: unknown) {
        (updates[table] ??= []).push(payload);
        return {
          eq: (_col: string, _val: unknown) => Promise.resolve({ error: null }),
        };
      },
      insert(rows: unknown[]) {
        insertCalls[table] = (insertCalls[table] ?? 0) + 1;
        (inserted[table] ??= []).push(...rows);
        return Promise.resolve({ error: null });
      },
      // Auto Scan Lock re-entrancy: processScan clears prior AI rows for the
      // scan before re-inserting. Record the delete().eq() so the re-entrancy
      // test can assert it happened without duplicating rows.
      delete() {
        deletes[table] = (deletes[table] ?? 0) + 1;
        return {
          eq: (_col: string, _val: unknown) => Promise.resolve({ error: null }),
        };
      },
    };
  }

  const client = {
    from: (table: string) => makeQueryBuilder(table),
    storage: {
      from: (_bucket: string) => ({
        createSignedUrl: (path: string, _ttl: number) =>
          signedUrlError
            ? Promise.resolve({ data: null, error: { message: signedUrlError } })
            : Promise.resolve({ data: { signedUrl: `https://signed.example/${path}` }, error: null }),
      }),
    },
  };

  return {
    client: client as unknown as SupabaseClient,
    inserted,
    updates,
    deletes,
    insertCalls,
    failSignedUrl(message: string) {
      signedUrlError = message;
    },
  };
}

function baseParams(
  overrides: Partial<Parameters<typeof processScan>[0]> &
    Pick<Parameters<typeof processScan>[0], "serviceClient">,
): Parameters<typeof processScan>[0] {
  return {
    scanId: "scan-1",
    scan: { id: "scan-1", specimen_category: null, capture_location: null },
    images: [
      { angle: "front", original_storage_path: "scan-1/front.jpg", processed_storage_path: null },
    ],
    onDeviceHint: null,
    ensembleScansEnabled: true,
    ...overrides,
  };
}

Deno.test("processScan: persists every provider response and the ranked ensemble candidates, returning a completed result", async () => {
  const { client, inserted, updates } = createMockServiceClient();
  const providers: VisionProvider[] = [
    mockProvider({
      name: "gemini_vision",
      identify: async () => ({
        provider: "gemini_vision",
        candidate: { label: "Amethyst", confidence: 0.9 },
        alternatives: [],
        reasoning: "purple banding",
        latencyMs: 500,
      }),
    }),
    mockProvider({
      name: "openai_vision",
      identify: async () => ({
        provider: "openai_vision",
        candidate: { label: "Amethyst", confidence: 0.8 },
        alternatives: [],
        reasoning: "hexagonal crystal habit",
        latencyMs: 600,
      }),
    }),
  ];

  const response = await processScan(baseParams({ serviceClient: client, providers }));
  const body = await response.json();

  assertEquals(response.status, 200);
  assertEquals(body.status, "completed");
  assertEquals(body.finalResult.bestMatch, "Amethyst");
  assertEquals(body.candidates[0].label, "Amethyst");

  assertEquals(inserted["scan_ai_responses"]?.length, 2);
  assertEquals(
    (inserted["scan_ai_responses"] as Array<{ candidate_label: string | null }>).map(
      (r) => r.candidate_label,
    ),
    ["Amethyst", "Amethyst"],
  );
  assertEquals(inserted["scan_candidates"]?.length, body.candidates.length);

  // First scans update flips status to "processing"; second flips to "completed".
  assertEquals(updates["scans"]?.length, 2);
  assertEquals((updates["scans"] as Array<{ status: string }>)[0].status, "processing");
  assertEquals((updates["scans"] as Array<{ status: string }>)[1].status, "completed");
});

Deno.test("processScan: persists each provider's scan_ai_responses row as its own call settles, not one bulk insert at the end", async () => {
  // Locks in the Progressive Results refactor: a slow provider must not delay
  // a fast provider's row from landing in the DB, so the mobile app can poll
  // scan_ai_responses mid-scan instead of staring at a blank screen. Asserted
  // here as "N separate insert() calls" rather than "1 call with N rows".
  const { client, inserted, insertCalls } = createMockServiceClient();
  const providers: VisionProvider[] = [
    mockProvider({
      name: "gemini_vision",
      identify: async () => {
        // Resolves fast — its row should be inserted well before the slow
        // provider below finishes, not batched together with it.
        return {
          provider: "gemini_vision",
          candidate: { label: "Amethyst", confidence: 0.9 },
          alternatives: [],
          reasoning: "",
          latencyMs: 5,
        };
      },
    }),
    mockProvider({
      name: "openai_vision",
      identify: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return {
          provider: "openai_vision",
          candidate: { label: "Amethyst", confidence: 0.85 },
          alternatives: [],
          reasoning: "",
          latencyMs: 20,
        };
      },
    }),
  ];

  const response = await processScan(baseParams({ serviceClient: client, providers }));
  await response.json();

  assertEquals(insertCalls["scan_ai_responses"], 2);
  assertEquals(inserted["scan_ai_responses"]?.length, 2);
});

Deno.test("processScan: providers whose isApplicable() returns false never run or get persisted", async () => {
  const { client, inserted } = createMockServiceClient();
  const providers: VisionProvider[] = [
    mockProvider({
      name: "hallmark_ocr",
      isApplicable: () => false,
      identify: async () => {
        throw new Error("should never be called");
      },
    }),
    mockProvider({
      name: "gemini_vision",
      identify: async () => ({
        provider: "gemini_vision",
        candidate: { label: "Pyrite", confidence: 0.8 },
        alternatives: [],
        reasoning: "",
        latencyMs: 100,
      }),
    }),
  ];

  const response = await processScan(baseParams({ serviceClient: client, providers }));
  await response.json();

  assertEquals(inserted["scan_ai_responses"]?.length, 1);
  assertEquals(
    (inserted["scan_ai_responses"] as Array<{ provider: string }>)[0].provider,
    "gemini_vision",
  );
});

Deno.test("processScan: providers gated behind requiresEnsembleTier are excluded when ensembleScansEnabled is false", async () => {
  const { client, inserted } = createMockServiceClient();
  const providers: VisionProvider[] = [
    mockProvider({
      name: "claude_vision",
      requiresEnsembleTier: true,
      identify: async () => {
        throw new Error("should never be called on free tier");
      },
    }),
    mockProvider({
      name: "on_device_classifier",
      identify: async () => ({
        provider: "on_device_classifier",
        candidate: { label: "Quartz", confidence: 0.6 },
        alternatives: [],
        reasoning: "",
        latencyMs: 5,
      }),
    }),
  ];

  const response = await processScan(
    baseParams({ serviceClient: client, providers, ensembleScansEnabled: false }),
  );
  await response.json();

  assertEquals(inserted["scan_ai_responses"]?.length, 1);
  assertEquals(
    (inserted["scan_ai_responses"] as Array<{ provider: string }>)[0].provider,
    "on_device_classifier",
  );
});

Deno.test("processScan: a provider that throws is isolated as an error result and does not break the scan", async () => {
  // This exercises withTimeout's catch branch (a rejected identify() call),
  // which is the same code path a real timed-out/thrown vendor call hits.
  // The real 25s timeout race itself isn't exercised here since that would
  // make the test suite slow; the per-provider isolation behavior it
  // guarantees is the same regardless of *why* a provider failed to resolve.
  const { client, inserted } = createMockServiceClient();
  const providers: VisionProvider[] = [
    mockProvider({
      name: "flaky_vendor",
      identify: async () => {
        throw new Error("vendor 503");
      },
    }),
    mockProvider({
      name: "gemini_vision",
      identify: async () => ({
        provider: "gemini_vision",
        candidate: { label: "Topaz", confidence: 0.85 },
        alternatives: [],
        reasoning: "",
        latencyMs: 50,
      }),
    }),
  ];

  const response = await processScan(baseParams({ serviceClient: client, providers }));
  const body = await response.json();

  assertEquals(body.status, "completed");
  assertEquals(body.finalResult.bestMatch, "Topaz");

  const responses = inserted["scan_ai_responses"] as Array<{
    provider: string;
    error: string | null;
    candidate_label: string | null;
  }>;
  const flaky = responses.find((r) => r.provider === "flaky_vendor")!;
  assertEquals(flaky.candidate_label, null);
  assertEquals(flaky.error, "vendor 503");
});

Deno.test("processScan: a failed signed-URL generation throws, so the caller can mark the scan failed", async () => {
  const { client, failSignedUrl } = createMockServiceClient();
  failSignedUrl("object not found");
  const providers: VisionProvider[] = [mockProvider({ name: "gemini_vision" })];

  await assertRejects(
    () => processScan(baseParams({ serviceClient: client, providers })),
    Error,
    "Failed to sign URL",
  );
});

Deno.test("processScan: when every provider abstains, the final result is insufficientConfidence and no candidates are persisted", async () => {
  const { client, inserted } = createMockServiceClient();
  const providers: VisionProvider[] = [
    mockProvider({ name: "gemini_vision" }), // default identify() abstains (candidate: null)
  ];

  const response = await processScan(baseParams({ serviceClient: client, providers }));
  const body = await response.json();

  assertEquals(body.finalResult.insufficientConfidence, true);
  assertEquals(body.finalResult.message, INSUFFICIENT_CONFIDENCE_MESSAGE);
  assertEquals(body.candidates.length, 0);
  assertEquals(inserted["scan_candidates"], undefined);
});

Deno.test("processScan: threads the caller-supplied onDeviceHint through to provider input", async () => {
  // Regression guard for the body-stream bug: onDeviceHint used to be re-read
  // inside processScan via `req.clone().json()`, which threw "Body already
  // consumed" in production (handleRequest had already read the body) and
  // failed every scan. It is now passed as a value; assert it reaches providers.
  const { client } = createMockServiceClient();
  let seenHint: ProviderInput["onDeviceHint"] = null;
  const providers: VisionProvider[] = [
    mockProvider({
      name: "gemini_vision",
      identify: async (input: ProviderInput) => {
        seenHint = input.onDeviceHint;
        return {
          provider: "gemini_vision",
          candidate: null,
          alternatives: [],
          reasoning: "",
          latencyMs: 1,
        };
      },
    }),
  ];

  await processScan(
    baseParams({
      serviceClient: client,
      providers,
      onDeviceHint: { label: "quartz", confidence: 0.42 },
    }),
  );

  assertEquals(seenHint, { label: "quartz", confidence: 0.42 });
});

Deno.test("processScan: threads the caller-supplied lang through to provider input, defaulting to 'en'", async () => {
  const { client } = createMockServiceClient();
  let seenLang: ProviderInput["lang"] | undefined;
  const providers: VisionProvider[] = [
    mockProvider({
      name: "gemini_vision",
      identify: async (input: ProviderInput) => {
        seenLang = input.lang;
        return { provider: "gemini_vision", candidate: null, alternatives: [], reasoning: "", latencyMs: 1 };
      },
    }),
  ];

  await processScan(baseParams({ serviceClient: client, providers }));
  assertEquals(seenLang, "en");

  await processScan(baseParams({ serviceClient: client, providers, lang: "so" }));
  assertEquals(seenLang, "so");
});

Deno.test("processScan: returns the backend auto-lock threshold (default 0.95)", async () => {
  const { client } = createMockServiceClient();
  const providers: VisionProvider[] = [mockProvider({ name: "gemini_vision" })];

  const response = await processScan(baseParams({ serviceClient: client, providers }));
  const body = await response.json();

  assertEquals(body.autoLockThreshold, 0.95);
});

Deno.test("processScan: finalResult carries null Dual Explanation Mode fields when no provider returns an analysis", async () => {
  const { client } = createMockServiceClient();
  const providers: VisionProvider[] = [
    mockProvider({
      name: "gemini_vision",
      identify: async () => ({
        provider: "gemini_vision",
        candidate: { label: "Amethyst", confidence: 0.9 },
        alternatives: [],
        reasoning: "",
        latencyMs: 10,
      }),
    }),
  ];

  const response = await processScan(
    baseParams({ serviceClient: client, providers, explanationStyle: "expert" }),
  );
  const body = await response.json();

  assertEquals(body.finalResult.explanationStyle, "expert");
  assertEquals(body.finalResult.simpleExplanation, null);
  assertEquals(body.finalResult.expertExplanation, null);
});

Deno.test("processScan: finalResult surfaces the winning provider's Simple/Expert write-up when available", async () => {
  const { client, inserted } = createMockServiceClient();
  const providers: VisionProvider[] = [
    mockProvider({
      name: "gemini_vision",
      identify: async () => ({
        provider: "gemini_vision",
        candidate: { label: "Amethyst", confidence: 0.9 },
        alternatives: [],
        reasoning: "purple banding",
        latencyMs: 500,
        analysis: {
          simpleExplanation: "This is probably amethyst, a purple quartz.",
          expertExplanation: {
            mineralSpecies: "Quartz",
            variety: "Amethyst",
            crystalSystem: "Trigonal",
            chemicalComposition: "SiO2",
            mohsHardness: "7",
            specificGravity: "2.65",
            refractiveIndex: "1.544-1.553",
            cleavage: "None",
            fracture: "Conchoidal",
            luster: "Vitreous",
            transparency: "Transparent",
            diagnosticCharacteristics: "Purple color zoning",
            geologicalOrigin: "Volcanic geode",
            commonTreatments: "Heat treatment common",
            syntheticIndicators: "Not determinable from photographs",
            commonImitations: "Glass, synthetic quartz",
            confidenceReasoning: "Clear color and habit match",
            recommendedLabTests: "None required for casual ID",
            marketDemand: "Moderate",
            wholesaleEstimate: "Low",
            retailEstimate: "Low to moderate",
            investmentConsiderations: "Common; low investment value",
          },
          imageObservations: "Purple coloring, visible crystal faces",
          warnings: "",
          recommendations: "None needed",
        },
      }),
    }),
  ];

  const response = await processScan(baseParams({ serviceClient: client, providers }));
  const body = await response.json();

  assertEquals(body.finalResult.simpleExplanation, "This is probably amethyst, a purple quartz.");
  assertEquals(body.finalResult.expertExplanation.mineralSpecies, "Quartz");
  assertEquals(body.finalResult.imageObservations, "Purple coloring, visible crystal faces");

  const responses = inserted["scan_ai_responses"] as Array<{ analysis: unknown }>;
  assertEquals(
    (responses[0].analysis as { simpleExplanation: string }).simpleExplanation,
    "This is probably amethyst, a purple quartz.",
  );
});

Deno.test("processScan: is re-entrant — clears prior AI rows before re-persisting so re-evaluation doesn't duplicate", async () => {
  // Auto Scan Lock may re-call the same scanId as evidence accumulates. Each
  // call must delete the scan's prior scan_ai_responses + scan_candidates
  // before inserting, so rows are replaced rather than duplicated.
  const { client, deletes } = createMockServiceClient();
  const providers: VisionProvider[] = [
    mockProvider({
      name: "gemini_vision",
      identify: async () => ({
        provider: "gemini_vision",
        candidate: { label: "Amethyst", confidence: 0.9 },
        alternatives: [],
        reasoning: "",
        latencyMs: 10,
      }),
    }),
  ];

  await processScan(baseParams({ serviceClient: client, providers }));

  assertEquals(deletes["scan_ai_responses"], 1);
  assertEquals(deletes["scan_candidates"], 1);
});
