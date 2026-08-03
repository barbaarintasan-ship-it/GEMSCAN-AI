// Integration tests for processVerification: signs verification photos, makes
// one Gemini call, and persists the verdict exclusively through the
// service_role client (never client-writable — see migration
// 0015_artifact_verification.sql). Mirrors verify-gold-value's suite.
//
// Run with: deno test --allow-env supabase/functions/verify-artifact-value/index.test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { processVerification } from "./index.ts";
// deno-lint-ignore no-explicit-any
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

function createMockServiceClient(opts: { reservedCount?: number | null } = {}) {
  const inserted: Record<string, unknown[]> = {};
  const updates: Record<string, unknown[]> = {};
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
      if (fn === "reserve_avr_evaluation_slot") {
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
    return new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { "content-type": "image/jpeg" },
    });
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = originalFetch) };
}

const VALID_VERDICT = {
  finalIdentification: "Possible wheel-thrown pottery sherd",
  confidence: 0.66,
  probability: "Possibly (50-70%)",
  reasoning: "Fabric, wear, and find context are consistent with a historical ceramic, but modern reproduction cannot be excluded from photos alone.",
  supportingEvidence: ["Even surface wear consistent with burial", "Found together with other sherds"],
  conflictingEvidence: ["No diagnostic rim or decoration visible"],
  mostLikelyAlternatives: [{ label: "Modern flowerpot fragment", note: "Rule out by fabric inspection in hand" }],
  recommendation: "needs_professional_examination",
  estimatedEra: "Possibly pre-modern; cannot narrow further from photos",
  estimatedCulture: "Undetermined",
  inscriptionReading: "",
  estimatedMarketValue: "Undetermined — depends on authenticity and legal provenance",
  professionalExaminationRecommended: true,
  professionalExaminationNote: "Have a museum ceramicist examine the fabric and any diagnostic features in hand.",
  heritageLegalNote: "Antiquities are legally protected in many countries; report a genuine-looking find to a museum or heritage authority before selling or moving it.",
  evidenceScore: 61,
  recommendedNextSteps: ["Museum curator", "University archaeology department"],
};

function baseParams(serviceClient: SupabaseClient): Parameters<typeof processVerification>[0] {
  return {
    verificationId: "verification-1",
    verification: {
      scan_id: "scan-1",
      answers: { buriedInGround: "partially_buried", foundWithOtherObjects: "yes" },
      image_paths: { macro: "user-1/scan-1/verification/macro.jpg" },
      status: "in_progress",
    },
    scan: {
      final_result: {
        bestMatch: "Pottery fragment",
        confidenceScore: 0.5,
        confidenceBand: "medium" as const,
        reasoning: "Ceramic texture with earthy residue.",
        alternatives: [{ label: "Modern ceramic", weightedConfidence: 0.3 }],
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
    assertEquals(body.verdict.finalIdentification, "Possible wheel-thrown pottery sherd");
    assertEquals(body.verdict.recommendation, "needs_professional_examination");
    assertEquals(typeof body.verdict.heritageLegalNote, "string");
    assertEquals(body.verdict.heritageLegalNote.length > 0, true);

    assertEquals(inserted["artifact_verification_verdicts"]?.length, 1);
    assertEquals(updates["artifact_verifications"]?.length, 1);
    assertEquals((updates["artifact_verifications"] as Array<{ status: string }>)[0].status, "completed");

    assertEquals(rpcCalls.length, 1);
    assertEquals(rpcCalls[0].fn, "reserve_avr_evaluation_slot");
    assertEquals((rpcCalls[0].args as { p_max: number }).p_max, 3);
  } finally {
    restore();
  }
});

Deno.test("processVerification: falls back to a non-empty heritage note if the model omits it", async () => {
  Deno.env.set("GEMINI_API_KEY", "test-key");
  const { client } = createMockServiceClient();
  const withoutNote = { ...VALID_VERDICT, heritageLegalNote: "" };
  const { restore } = mockFetch(JSON.stringify(withoutNote));

  try {
    const response = await processVerification(baseParams(client));
    const body = await response.json();
    assertEquals(response.status, 200);
    assertEquals(body.verdict.heritageLegalNote.length > 0, true);
  } finally {
    restore();
  }
});

Deno.test("processVerification: returns 502 when Gemini errors, writes no verdict, and releases the reserved slot", async () => {
  Deno.env.set("GEMINI_API_KEY", "test-key");
  const { client, inserted, rpcCalls } = createMockServiceClient();
  const { restore } = mockFetch(JSON.stringify({ error: { message: "rate limited" } }), false);

  try {
    const response = await processVerification(baseParams(client));
    assertEquals(response.status, 502);
    assertEquals(inserted["artifact_verification_verdicts"], undefined);
    assertEquals(rpcCalls.map((c) => c.fn), ["reserve_avr_evaluation_slot", "release_avr_evaluation_slot"]);
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
    assertEquals(rpcCalls.map((c) => c.fn), ["reserve_avr_evaluation_slot"]);
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
