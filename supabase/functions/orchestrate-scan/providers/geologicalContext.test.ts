// Unit test for the Macrostrat lookup cache added for performance (see
// providers/geologicalContext.ts's `geoContextCache`).
// Run with: deno test --allow-none supabase/functions/orchestrate-scan/providers/geologicalContext.test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { geologicalContextProvider } from "./geologicalContext.ts";
import type { ProviderInput } from "./types.ts";

function mockInput(location: { lat: number; lng: number }): ProviderInput {
  return {
    scanId: "scan-1",
    images: [],
    specimenCategory: null,
    onDeviceHint: null,
    location,
    explanationStyle: "simple",
    // deno-lint-ignore no-explicit-any
    serviceClient: {} as any,
  };
}

Deno.test("geologicalContextProvider: a second call for a nearby (same-bucket) location is served from cache, not a second API call", async () => {
  const originalFetch = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = ((..._args: Parameters<typeof fetch>) => {
    callCount += 1;
    return Promise.resolve(
      new Response(
        JSON.stringify({ success: { data: [{ lith: "granite" }] } }),
        { status: 200 },
      ),
    );
  }) as typeof fetch;

  try {
    const location = { lat: 41.123456, lng: -71.654321 }; // distinctive, test-local coords
    const first = await geologicalContextProvider.identify(mockInput(location));
    assertEquals(callCount, 1);
    assertEquals(first.candidate?.label, "quartz");

    // Slightly different coords that round to the same ~1km bucket.
    const second = await geologicalContextProvider.identify(
      mockInput({ lat: 41.1234, lng: -71.6543 }),
    );
    assertEquals(callCount, 1); // still 1 — served from cache
    assertEquals(second.candidate?.label, "quartz");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
