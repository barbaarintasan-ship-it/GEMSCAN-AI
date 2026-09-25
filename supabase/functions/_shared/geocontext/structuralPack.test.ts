// Real bug fix (2026-09-25 audit) — fetchCommodityProfile is the one new
// piece of logic all three Team buildEngine() paths (team-targeting,
// discover-region-targets, score-mission-cells) now share to close the
// `commodities: []` gap. Tested here once, directly, rather than duplicated
// per caller.
import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { fetchCommodityProfile, packWithMapFeatures } from "./structuralPack.ts";

function fakeClient(rpcResult: { data?: unknown; error?: { message: string } | null }) {
  return {
    schema: (_name: string) => ({
      rpc: async (fn: string, args: Record<string, unknown>) => {
        assertEquals(fn, "commodity_profiles");
        return rpcResult;
      },
    }),
  } as any;
}

Deno.test("[fetchCommodityProfile] no commodity requested → empty array, RPC never needs to be reached", async () => {
  let called = false;
  const client = {
    schema: () => ({ rpc: async () => { called = true; return { data: [] }; } }),
  } as any;
  const result = await fetchCommodityProfile(client, null);
  assertEquals(result, []);
  assertEquals(called, false, "the RPC must not be called when there is nothing to look up");
});

Deno.test("[fetchCommodityProfile] undefined commodity also short-circuits to empty array", async () => {
  const client = { schema: () => ({ rpc: async () => ({ data: [{ code: "gold" }] }) }) } as any;
  assertEquals(await fetchCommodityProfile(client, undefined), []);
});

Deno.test("[fetchCommodityProfile] a real commodity code requests exactly that one code from the RPC", async () => {
  let receivedArgs: Record<string, unknown> | null = null;
  const client = {
    schema: () => ({
      rpc: async (fn: string, args: Record<string, unknown>) => {
        receivedArgs = args;
        return { data: [{ code: "gold", name: "Gold", typical_host_rocks: ["quartz vein"] }] };
      },
    }),
  } as any;
  const result = await fetchCommodityProfile(client, "gold");
  assertEquals(receivedArgs, { p_codes: ["gold"] });
  assertEquals(result.length, 1);
  assertEquals(result[0].code, "gold");
});

Deno.test("[fetchCommodityProfile] an unknown code returns an empty array, not an error", async () => {
  const client = fakeClient({ data: [] });
  const result = await fetchCommodityProfile(client, "unobtainium");
  assertEquals(result, []);
});

Deno.test("[fetchCommodityProfile] a null data response is treated as empty, never crashes", async () => {
  const client = fakeClient({ data: null });
  assertEquals(await fetchCommodityProfile(client, "gold"), []);
});

Deno.test("[fetchCommodityProfile] an RPC error is surfaced, not swallowed", async () => {
  const client = fakeClient({ error: { message: "boom" } });
  await assertRejects(() => fetchCommodityProfile(client, "gold"), Error, "commodity_profiles: boom");
});

Deno.test("[packWithMapFeatures] defaults commodities to an empty array when omitted — unchanged old behaviour", () => {
  const pack = packWithMapFeatures([]);
  assertEquals(pack.commodities, []);
});

Deno.test("[packWithMapFeatures] a supplied commodity profile list is carried through verbatim", () => {
  const profile = { code: "gold", name: "Gold" } as any;
  const pack = packWithMapFeatures([], [profile]);
  assertEquals(pack.commodities, [profile]);
});
