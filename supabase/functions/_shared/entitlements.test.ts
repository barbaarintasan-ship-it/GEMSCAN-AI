// Unit tests for featuresForTier() — the single source of truth for
// tier-gated feature access shared between verify-subscription and
// orchestrate-scan.
// Run with: deno test supabase/functions/_shared/entitlements.test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  deepScanAllowanceFor,
  featuresForTier,
  isOwnerEmail,
  OWNER_DEEP_SCAN_ALLOWANCE,
  resolveEffectiveTier,
} from "./entitlements.ts";

Deno.test("featuresForTier: professional (Gem Collector) — 100 Deep Scans, no unlimited ensemble", () => {
  const features = featuresForTier("professional");
  assertEquals(features.standardScanDailyLimit, 100);
  assertEquals(features.deepScanAllowance, 100);
  assertEquals(features.askAGemologist, true);
  assertEquals(features.inventoryManagement, true);
  assertEquals(features.pdfReports, true);
  assertEquals(features.batchScanning, true);
  // The unlimited-ensemble flag must NOT exist any more.
  assertEquals((features as Record<string, unknown>).ensembleScans, undefined);
});

Deno.test("featuresForTier: premium (Explorer) — 20 Deep Scans", () => {
  const features = featuresForTier("premium");
  assertEquals(features.standardScanDailyLimit, 30);
  assertEquals(features.deepScanAllowance, 20);
  assertEquals(features.inventoryManagement, false);
});

Deno.test("featuresForTier: lifetime is treated identically to premium", () => {
  assertEquals(featuresForTier("lifetime"), featuresForTier("premium"));
});

Deno.test("featuresForTier: free — 3 Standard/day, 0 Deep Scans", () => {
  const features = featuresForTier("free");
  assertEquals(features.standardScanDailyLimit, 3);
  assertEquals(features.deepScanAllowance, 0);
  assertEquals(features.pdfReports, false);
});

Deno.test("featuresForTier: unknown tier falls back to free", () => {
  assertEquals(featuresForTier("some_unrecognized_tier"), featuresForTier("free"));
});

Deno.test("featuresForTier: empty string tier falls back to free (fail-closed)", () => {
  const features = featuresForTier("");
  assertEquals(features.standardScanDailyLimit, 3);
  assertEquals(features.deepScanAllowance, 0);
});

Deno.test("deepScanAllowanceFor: owner is effectively unlimited; others get their tier allowance", () => {
  assertEquals(deepScanAllowanceFor("awmusse.musse@gmail.com", "professional"), OWNER_DEEP_SCAN_ALLOWANCE);
  assertEquals(deepScanAllowanceFor("user@example.com", "professional"), 100);
  assertEquals(deepScanAllowanceFor("user@example.com", "premium"), 20);
  assertEquals(deepScanAllowanceFor("user@example.com", "free"), 0);
});

Deno.test("isOwnerEmail: owner email matches, case- and whitespace-insensitively", () => {
  assertEquals(isOwnerEmail("awmusse.musse@gmail.com"), true);
  assertEquals(isOwnerEmail("AwMusse.Musse@Gmail.com"), true);
  assertEquals(isOwnerEmail("  awmusse.musse@gmail.com  "), true);
});

Deno.test("isOwnerEmail: non-owner and empty/null emails are not owners", () => {
  assertEquals(isOwnerEmail("someone.else@gmail.com"), false);
  assertEquals(isOwnerEmail(""), false);
  assertEquals(isOwnerEmail(null), false);
  assertEquals(isOwnerEmail(undefined), false);
});

Deno.test("resolveEffectiveTier: owner is always professional, even with no/canceled subscription", () => {
  assertEquals(resolveEffectiveTier("awmusse.musse@gmail.com", null), "professional");
  assertEquals(
    resolveEffectiveTier("awmusse.musse@gmail.com", { tier: "free", status: "canceled" }),
    "professional",
  );
  // And owner's Deep Scan allowance is effectively unlimited.
  assertEquals(
    deepScanAllowanceFor("awmusse.musse@gmail.com", resolveEffectiveTier("awmusse.musse@gmail.com", null)),
    OWNER_DEEP_SCAN_ALLOWANCE,
  );
});

Deno.test("resolveEffectiveTier: non-owner gets active tier, or free when inactive/absent", () => {
  assertEquals(resolveEffectiveTier("user@example.com", { tier: "premium", status: "active" }), "premium");
  assertEquals(resolveEffectiveTier("user@example.com", { tier: "premium", status: "canceled" }), "free");
  assertEquals(resolveEffectiveTier("user@example.com", null), "free");
});
