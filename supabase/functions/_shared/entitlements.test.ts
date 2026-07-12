// Unit tests for featuresForTier() — the single source of truth for
// tier-gated feature access shared between verify-subscription and
// orchestrate-scan.
// Run with: deno test supabase/functions/_shared/entitlements.test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { featuresForTier } from "./entitlements.ts";

Deno.test("featuresForTier: professional tier unlocks everything with unlimited scans", () => {
  const features = featuresForTier("professional");
  assertEquals(features.dailyScanLimit, null);
  assertEquals(features.ensembleScans, true);
  assertEquals(features.askAGemologist, true);
  assertEquals(features.inventoryManagement, true);
  assertEquals(features.pdfReports, true);
  assertEquals(features.batchScanning, true);
});

Deno.test("featuresForTier: lifetime tier unlocks unlimited scans + ensemble/ask-a-gemologist but not the professional-only features", () => {
  const features = featuresForTier("lifetime");
  assertEquals(features.dailyScanLimit, null);
  assertEquals(features.ensembleScans, true);
  assertEquals(features.askAGemologist, true);
  assertEquals(features.inventoryManagement, false);
  assertEquals(features.pdfReports, false);
  assertEquals(features.batchScanning, false);
});

Deno.test("featuresForTier: premium tier is treated identically to lifetime", () => {
  const lifetime = featuresForTier("lifetime");
  const premium = featuresForTier("premium");
  assertEquals(premium, lifetime);
});

Deno.test("featuresForTier: free tier is limited to 5 scans/day with no premium features", () => {
  const features = featuresForTier("free");
  assertEquals(features.dailyScanLimit, 5);
  assertEquals(features.ensembleScans, false);
  assertEquals(features.askAGemologist, false);
  assertEquals(features.inventoryManagement, false);
  assertEquals(features.pdfReports, false);
  assertEquals(features.batchScanning, false);
});

Deno.test("featuresForTier: unknown/unrecognized tier strings fall back to the free tier, not an unlocked one", () => {
  const unknown = featuresForTier("some_unrecognized_tier");
  const free = featuresForTier("free");
  assertEquals(unknown, free);
});

Deno.test("featuresForTier: empty string tier falls back to free (fail-closed, not fail-open)", () => {
  const features = featuresForTier("");
  assertEquals(features.dailyScanLimit, 5);
  assertEquals(features.ensembleScans, false);
});
