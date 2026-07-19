// Integration tests for processVerification: signs verification photos,
// makes one Gemini call, and persists the verdict exclusively through the
// service_role client (never client-writable — see migration
// 0009_diamond_verification.sql). Ownership itself is proven by handleRequest's
// RLS-scoped reads before processVerification ever runs — same split as
// orchestrate-scan's handleRequest/processScan, and not re-tested here for the
// same reason orchestrate-scan's own test suite doesn't re-test that layer.
//
// Run with: deno test --allow-env supabase/functions/verify-high-value/index.test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { processVerification } from "./index.ts";
// deno-lint-ignore no-explicit-any
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

function createMockServiceClient() {
  const inserted: Record<string, unknown[]> = {};
  const updates: Record<string, unknown[]> = {};

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

  const client = {
    from: (table: string) => makeQueryBuilder(table),
    storage: {
      from: (_bucket: string) => ({
        createSignedUrl: (path: string, _ttl: number) =>
          Promise.resolve({ data: { signedUrl: `https://signed.example/${path}` }, error: null }),
      }),
    },
  };

  return { client: client as unknown as SupabaseClient, inserted, updates };
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
  finalIdentification: "Natural Diamond",
  confidence: 0.8,
  probability: "Likely (75-90%)",
  reasoning: "Hardness, fire, and fog behavior all consistent.",
  supportingEvidence: ["Scratches glass but not steel", "Fog clears immediately"],
  conflictingEvidence: [],
  mostLikelyAlternatives: [{ label: "Moissanite", note: "Ruled out by fog test" }],
  recommendation: "likely_natural_diamond",
  estimatedMarketValue: "Potentially significant if confirmed natural",
  professionalTestingRecommended: true,
  professionalTestingNote: "Recommend certified lab testing before any sale.",
  evidenceScore: 88,
  recommendedNextTests: ["Thermal Diamond Tester", "GIA"],
};

function baseParams(serviceClient: SupabaseClient): Parameters<typeof processVerification>[0] {
  return {
    verificationId: "verification-1",
    verification: {
      scan_id: "scan-1",
      answers: { scratchesGlass: "yes", fogClearTime: "immediately" },
      image_paths: { macro: "user-1/scan-1/verification/macro.jpg" },
      status: "in_progress",
    },
    scan: {
      final_result: {
        bestMatch: "Diamond",
        confidenceScore: 0.6,
        confidenceBand: "medium" as const,
        reasoning: "Strong brilliance.",
        alternatives: [{ label: "Moissanite", weightedConfidence: 0.3 }],
      },
      capture_location: null,
    },
    hallmark: null,
    serviceClient,
  };
}

Deno.test("processVerification: persists the verdict and marks the verification completed via service_role only", async () => {
  Deno.env.set("GEMINI_API_KEY", "test-key");
  const { client, inserted, updates } = createMockServiceClient();
  const { restore } = mockFetch(JSON.stringify(VALID_VERDICT));

  try {
    const response = await processVerification(baseParams(client));
    const body = await response.json();

    assertEquals(response.status, 200);
    assertEquals(body.verdict.finalIdentification, "Natural Diamond");
    assertEquals(body.verdict.recommendation, "likely_natural_diamond");

    assertEquals(inserted["diamond_verification_verdicts"]?.length, 1);
    assertEquals(
      (inserted["diamond_verification_verdicts"] as Array<{ verification_id: string; scan_id: string }>)[0]
        .verification_id,
      "verification-1",
    );
    assertEquals(updates["diamond_verifications"]?.length, 1);
    assertEquals((updates["diamond_verifications"] as Array<{ status: string }>)[0].status, "completed");
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
    assertEquals(inserted["diamond_verification_verdicts"]?.length, 1);
    // Only the Gemini call should have happened — no image fetch.
    assertEquals(calls.filter((u) => u.includes("generativelanguage")).length, 1);
    assertEquals(calls.filter((u) => u.includes("signed.example")).length, 0);
  } finally {
    restore();
  }
});

Deno.test("processVerification: returns 502 (not a crash) when Gemini errors, and writes no verdict", async () => {
  Deno.env.set("GEMINI_API_KEY", "test-key");
  const { client, inserted } = createMockServiceClient();
  const { restore } = mockFetch(JSON.stringify({ error: { message: "rate limited" } }), false);

  try {
    const response = await processVerification(baseParams(client));
    assertEquals(response.status, 502);
    assertEquals(inserted["diamond_verification_verdicts"], undefined);
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
