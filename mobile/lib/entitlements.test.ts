import { goldProspectEnabled } from "./entitlements";
import type { SubscriptionStatus, SubscriptionTier, SubscriptionFeatures } from "./subscription";

function makeSub(tier: SubscriptionTier, features: Partial<SubscriptionFeatures> = {}): SubscriptionStatus {
  return {
    tier,
    status: "active",
    currentPeriodEnd: null,
    source: null,
    features: {
      standardScanDailyLimit: null,
      deepScanAllowance: 0,
      askAGemologist: false,
      inventoryManagement: false,
      pdfReports: tier === "professional",
      batchScanning: false,
      ...features,
    },
    deepScan: { allowance: 0, used: 0, purchased: 0, remaining: 0 },
  };
}

describe("goldProspectEnabled", () => {
  it("is false without a subscription", () => {
    expect(goldProspectEnabled(null)).toBe(false);
    expect(goldProspectEnabled(undefined)).toBe(false);
  });

  it("derives from the professional (Gem Collector) tier when no explicit flag", () => {
    expect(goldProspectEnabled(makeSub("professional"))).toBe(true);
    expect(goldProspectEnabled(makeSub("premium"))).toBe(false);
    expect(goldProspectEnabled(makeSub("lifetime"))).toBe(false);
    expect(goldProspectEnabled(makeSub("free"))).toBe(false);
  });

  it("prefers an explicit backend flag when present", () => {
    expect(goldProspectEnabled(makeSub("free", { goldProspectEvaluation: true }))).toBe(true);
    expect(goldProspectEnabled(makeSub("professional", { goldProspectEvaluation: false }))).toBe(false);
  });
});
