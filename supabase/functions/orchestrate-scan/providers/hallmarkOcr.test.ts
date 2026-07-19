// Unit test for the reference_hallmarks lookup cache added for performance
// (see providers/hallmarkOcr.ts's `hallmarkLookupCache`).
// Run with: deno test --allow-none supabase/functions/orchestrate-scan/providers/hallmarkOcr.test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { lookupHallmarks } from "./hallmarkOcr.ts";
import type { ProviderInput } from "./types.ts";

function mockInput(queryCount: { n: number }): ProviderInput {
  const serviceClient = {
    from: (_table: string) => ({
      select: (_cols: string) => ({
        ilike: (_col: string, _pattern: string) => ({
          limit: (_n: number) => {
            queryCount.n += 1;
            return Promise.resolve({
              data: [
                {
                  mark_code: "925-cache-test",
                  country: "UK",
                  assay_office: "London",
                  metal_type: "silver",
                  fineness: "925",
                  period_start: null,
                  period_end: null,
                },
              ],
              error: null,
            });
          },
        }),
      }),
    }),
    // deno-lint-ignore no-explicit-any
  } as any;

  return {
    scanId: "scan-1",
    images: [],
    specimenCategory: "jewelry",
    onDeviceHint: null,
    location: null,
    explanationStyle: "simple",
    lang: "en",
    serviceClient,
  };
}

Deno.test("lookupHallmarks: a second lookup of the same mark is served from cache, not a second DB query", async () => {
  const queryCount = { n: 0 };
  const input = mockInput(queryCount);

  const first = await lookupHallmarks(input, ["925-cache-test"]);
  assertEquals(queryCount.n, 1);
  assertEquals(first.length, 1);
  assertEquals(first[0].label, "silver · 925 · London · UK");

  const second = await lookupHallmarks(input, ["925-cache-test"]);
  assertEquals(queryCount.n, 1); // still 1 — served from cache
  assertEquals(second, first);
});

Deno.test("lookupHallmarks: cache lookup is case-insensitive on the mark", async () => {
  const queryCount = { n: 0 };
  const input = mockInput(queryCount);

  await lookupHallmarks(input, ["ABC-Case-Test"]);
  assertEquals(queryCount.n, 1);

  await lookupHallmarks(input, ["abc-case-test"]);
  assertEquals(queryCount.n, 1); // same cache key after lowercasing
});
