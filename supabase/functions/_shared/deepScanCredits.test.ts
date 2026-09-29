// Unit tests for the standard-scan accounting helpers that front the atomic
// consume_standard_scan SQL function (migration 0161). The SQL function's
// accounting logic (cap, de-dup, window, idempotency, concurrency) is proven
// against a real Postgres in supabase/tests/standard_scan_lifetime.verify.sql;
// these tests cover the TypeScript seam: correct RPC params, result mapping,
// error propagation, and the failure-path refund.
//
// Run with: deno test supabase/functions/_shared/deepScanCredits.test.ts
import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { consumeStandardScan, refundStandardScan } from "./deepScanCredits.ts";
// deno-lint-ignore no-explicit-any
type AnyClient = any;

Deno.test("consumeStandardScan: passes the right RPC args and maps an allowed verdict", async () => {
  let calledFn = "";
  let calledArgs: Record<string, unknown> = {};
  const client: AnyClient = {
    rpc(fn: string, args: Record<string, unknown>) {
      calledFn = fn;
      calledArgs = args;
      return Promise.resolve({
        data: [{ allowed: true, used: 3, remaining: 7, already_counted: false }],
        error: null,
      });
    },
  };

  const verdict = await consumeStandardScan(client, {
    userId: "u1",
    scanId: "s1",
    plan: "free",
    limit: 10,
    lifetime: true,
    aiModels: ["gemini"],
  });

  assertEquals(calledFn, "consume_standard_scan");
  assertEquals(calledArgs, {
    p_user_id: "u1",
    p_scan_id: "s1",
    p_limit: 10,
    p_lifetime: true,
    p_plan: "free",
    p_ai_models: ["gemini"],
  });
  assertEquals(verdict, { allowed: true, used: 3, remaining: 7, alreadyCounted: false });
});

Deno.test("consumeStandardScan: maps a blocked verdict (limit reached)", async () => {
  const client: AnyClient = {
    rpc: () => Promise.resolve({
      data: [{ allowed: false, used: 10, remaining: 0, already_counted: false }],
      error: null,
    }),
  };
  const verdict = await consumeStandardScan(client, {
    userId: "u1", scanId: "s1", plan: "free", limit: 10, lifetime: true,
  });
  assertEquals(verdict.allowed, false);
  assertEquals(verdict.remaining, 0);
});

Deno.test("consumeStandardScan: maps an idempotent retry (already_counted, no re-block)", async () => {
  const client: AnyClient = {
    rpc: () => Promise.resolve({
      data: [{ allowed: true, used: 5, remaining: 5, already_counted: true }],
      error: null,
    }),
  };
  const verdict = await consumeStandardScan(client, {
    userId: "u1", scanId: "dup", plan: "free", limit: 10, lifetime: true,
  });
  assertEquals(verdict.alreadyCounted, true);
  assertEquals(verdict.allowed, true);
});

Deno.test("consumeStandardScan: defaults aiModels to ['gemini'] when omitted", async () => {
  let args: Record<string, unknown> = {};
  const client: AnyClient = {
    rpc: (_fn: string, a: Record<string, unknown>) => {
      args = a;
      return Promise.resolve({ data: [{ allowed: true, used: 1, remaining: 9, already_counted: false }], error: null });
    },
  };
  await consumeStandardScan(client, { userId: "u1", scanId: "s1", plan: "free", limit: 10, lifetime: true });
  assertEquals(args.p_ai_models, ["gemini"]);
});

Deno.test("consumeStandardScan: unlimited (paid) tier maps remaining=null", async () => {
  const client: AnyClient = {
    rpc: () => Promise.resolve({
      data: [{ allowed: true, used: 42, remaining: null, already_counted: false }],
      error: null,
    }),
  };
  const verdict = await consumeStandardScan(client, {
    userId: "u1", scanId: "s1", plan: "professional", limit: null, lifetime: false,
  });
  assertEquals(verdict.allowed, true);
  assertEquals(verdict.remaining, null);
});

Deno.test("consumeStandardScan: throws on RPC error (never silently allows)", async () => {
  const client: AnyClient = {
    rpc: () => Promise.resolve({ data: null, error: { message: "boom" } }),
  };
  await assertRejects(
    () => consumeStandardScan(client, { userId: "u1", scanId: "s1", plan: "free", limit: 10, lifetime: true }),
    Error,
    "boom",
  );
});

Deno.test("consumeStandardScan: throws when the function returns no row", async () => {
  const client: AnyClient = {
    rpc: () => Promise.resolve({ data: [], error: null }),
  };
  await assertRejects(
    () => consumeStandardScan(client, { userId: "u1", scanId: "s1", plan: "free", limit: 10, lifetime: true }),
    Error,
    "no row",
  );
});

Deno.test("refundStandardScan: deletes exactly the standard row for that user+scan", async () => {
  const eqCalls: Array<[string, unknown]> = [];
  let deleteCalled = false;
  let table = "";
  const builder: AnyClient = {
    delete() { deleteCalled = true; return this; },
    eq(col: string, val: unknown) { eqCalls.push([col, val]); return this; },
    then(resolve: (v: unknown) => void) { resolve({ error: null }); }, // awaitable
  };
  const client: AnyClient = { from(t: string) { table = t; return builder; } };

  await refundStandardScan(client, { userId: "u9", scanId: "sX" });

  assertEquals(table, "scan_usage");
  assert(deleteCalled);
  assertEquals(eqCalls, [["user_id", "u9"], ["scan_id", "sX"], ["scan_type", "standard"]]);
});

Deno.test("refundStandardScan: swallows errors (best-effort, never throws)", async () => {
  const client: AnyClient = {
    from() { throw new Error("db down"); },
  };
  // Must not throw — a failed refund over-counts by one at worst, never crashes.
  await refundStandardScan(client, { userId: "u9", scanId: "sX" });
});
