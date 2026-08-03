// Integration tests for processVerification: signs verification photos,
// makes one Gemini call, and persists the verdict exclusively through the
// service_role client (never client-writable — see migration
// 0013_gold_verification.sql). Ownership itself is proven by handleRequest's
// RLS-scoped reads before processVerification ever runs — same split as
// verify-high-value's own test suite, and not re-tested here for the same
// reason.
//
// Run with: deno test --allow-env supabase/functions/verify-gold-value/index.test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { processVerification } from "./index.ts";
// deno-lint-ignore no-explicit-any
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

function createMockServiceClient(opts: { reservedCount?: number | null } = {}) {
  const inserted: Record<string, unknown[]> = {};
  const updates: Record<string, unknown[]> = {};
  // Defaults to "a slot is available" (1) so tests that aren't specifically
  // exercising the cap don't need to know reserve_gvr_evaluation_slot exists.
  // NOTE: use "in" rather than "??" — null is the deliberate "at cap" value
  // a caller passes, and "??" would treat that null the same as "not passed".
  const reservedCount = "reservedCount" in opts ? opts.reservedCount : 1;

  // deno-lint-ignore no-explicit-any
  function makeQueryBuilder(table: string): any {
    return {
      insert(rows: unknown[]) {
        (inserted[table] ??= []).push(...rows);
        return Promise.resolve({ error: null });
      },
      update(payload: unknown) {
        (updates[table] ??= []).push(payload);
        return { eq: (_col: string, _val: unknown) => Promise.resolve({ error: null }) };
      },
    };
  }

  const rpcCalls: { fn: string; args: unknown }[] = [];
  const client = {
    from: (table: string) => makeQueryBuilder(table),
    storage: {
      from: (_bucket: string) => ({
        createSignedUrl: (path: string, _ttl: number) =>
          Promise.resolve({ data: { signedUrl: `https://signed.example/${path}` }, error: null }),
      }),
    },
    rpc: (fn: string, args: unknown) => {
      rpcCalls.push({ fn, args });
      if (fn === "reserve_gvr_evaluation_slot") {
        return Promise.resolve({ data: reservedCount, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
  };

  return { client: client as unknown as SupabaseClient, inserted, updates, rpcCalls };
}

function mockFetch(geminiResponseText: string, geminiOk = true) {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, _init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("generativelanguage.googleapis.com")) {
      return new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ text: geminiResponseText }] } }] }),
        { status: geminiOk ? 200 : 500 },
      );
    }
    // Signed verification image fetch (fetchImageAsBase64).
    return new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { "content-type": "image/jpeg" },
    });
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = originalFetch) };
}

const VALID_VERDICT = {
  finalIdentification: "Natural gold candidate",
  confidence: 0.82,
  probability: "Likely (75-90%)",
  reasoning: "Non-magnetic, yellow streak, and density all consistent with gold.",
  supportingEvidence: ["Metallic yellow appearance", "Non-magnetic response", "Density calculation consistent with gold"],
  conflictingEvidence: [],
  mostLikelyAlternatives: [{ label: "Pyrite", note: "Ruled out by yellow streak and non-magnetic response" }],
  recommendation: "likely_natural_gold",
  estimatedPurityOptions: ["22K", "24K"],
  estimatedMarketValue: "Potentially significant if confirmed natural — professional assay needed",
  professionalTestingRecommended: true,
  professionalTestingNote: "Recommend XRF or certified assay before any sale.",
  evidenceScore: 74,
  recommendedNextTests: ["XRF Analyzer", "Certified Assay Office"],
};

function baseParams(serviceClient: SupabaseClient): Parameters<typeof processVerification>[0] {
  return {
    verificationId: "verification-1",
    verification: {
      scan_id: "scan-1",
      answers: { magnetAttracts: "no", streakColor: "yellow_gold" },
      image_paths: { macro: "user-1/scan-1/verification/macro.jpg" },
      status: "in_progress",
    },
    scan: {
      final_result: {
        bestMatch: "Native Gold Nugget",
        confidenceScore: 0.6,
        confidenceBand: "medium" as const,
        reasoning: "Metallic yellow luster with quartz association.",
        alternatives: [{ label: "Pyrite", weightedConfidence: 0.25 }],
      },
      capture_location: null,
    },
    hallmark: null,
    serviceClient,
  };
}

Deno.test("processVerification: persists the verdict and marks the verification completed via service_role only", async () => {
  Deno.env.set("GEMINI_API_KEY", "test-key");
  const { client, inserted, updates, rpcCalls } = createMockServiceClient();
  const { restore } = mockFetch(JSON.stringify(VALID_VERDICT));

  try {
    const response = await processVerification(baseParams(client));
    const body = await response.json();

    assertEquals(response.status, 200);
    assertEquals(body.verdict.finalIdentification, "Natural gold candidate");
    assertEquals(body.verdict.recommendation, "likely_natural_gold");
    assertEquals(body.verdict.estimatedPurityOptions, ["22K", "24K"]);

    assertEquals(inserted["gold_verification_verdicts"]?.length, 1);
    assertEquals(
      (inserted["gold_verification_verdicts"] as Array<{ verification_id: string; scan_id: string }>)[0]
        .verification_id,
      "verification-1",
    );
    assertEquals(updates["gold_verifications"]?.length, 1);
    assertEquals((updates["gold_verifications"] as Array<{ status: string }>)[0].status, "completed");

    // Reserves an evaluation slot atomically up front (before any AI work),
    // and does NOT release it on a successful run.
    assertEquals(rpcCalls.length, 1);
    assertEquals(rpcCalls[0].fn, "reserve_gvr_evaluation_slot");
    assertEquals(
      (rpcCalls[0].args as { p_verification_id: string; p_max: number }).p_verification_id,
      "verification-1",
    );
    assertEquals((rpcCalls[0].args as { p_max: number }).p_max, 3);
  } finally {
    restore();
  }
});

Deno.test("processVerification: still produces a verdict when no verification photos were captured", async () => {
  Deno.env.set("GEMINI_API_KEY", "test-key");
  const { client, inserted } = createMockServiceClient();
  const { calls, restore } = mockFetch(JSON.stringify(VALID_VERDICT));

  try {
    const params = baseParams(client);
    params.verification.image_paths = {};
    const response = await processVerification(params);

    assertEquals(response.status, 200);
    assertEquals(inserted["gold_verification_verdicts"]?.length, 1);
    // Only the Gemini call should have happened — no image fetch.
    assertEquals(calls.filter((u) => u.includes("generativelanguage")).length, 1);
    assertEquals(calls.filter((u) => u.includes("signed.example")).length, 0);
  } finally {
    restore();
  }
});

Deno.test("processVerification: returns 502 (not a crash) when Gemini errors, writes no verdict, and releases the reserved slot", async () => {
  Deno.env.set("GEMINI_API_KEY", "test-key");
  const { client, inserted, rpcCalls } = createMockServiceClient();
  const { restore } = mockFetch(JSON.stringify({ error: { message: "rate limited" } }), false);

  try {
    const response = await processVerification(baseParams(client));
    assertEquals(response.status, 502);
    assertEquals(inserted["gold_verification_verdicts"], undefined);
    // A failed Gemini call must not permanently cost the user one of their 3
    // evaluations — the slot reserved up front is given back.
    assertEquals(rpcCalls.map((c) => c.fn), ["reserve_gvr_evaluation_slot", "release_gvr_evaluation_slot"]);
  } finally {
    restore();
  }
});

Deno.test("processVerification: rejects with 429 when the purchase is already at its evaluation cap", async () => {
  Deno.env.set("GEMINI_API_KEY", "test-key");
  const { client, rpcCalls } = createMockServiceClient({ reservedCount: null });
  const { restore } = mockFetch(JSON.stringify(VALID_VERDICT));

  try {
    const response = await processVerification(baseParams(client));
    const body = await response.json();
    assertEquals(response.status, 429);
    assertEquals(typeof body.error, "string");
    // Never calls Gemini at all once the atomic reservation says "no slot".
    assertEquals(rpcCalls.map((c) => c.fn), ["reserve_gvr_evaluation_slot"]);
  } finally {
    restore();
  }
});

Deno.test("processVerification: returns 500 when GEMINI_API_KEY is not configured", async () => {
  Deno.env.delete("GEMINI_API_KEY");
  const { client } = createMockServiceClient();
  const { restore } = mockFetch(JSON.stringify(VALID_VERDICT));

  try {
    const response = await processVerification(baseParams(client));
    assertEquals(response.status, 500);
  } finally {
    restore();
  }
});
