// Integration-level coverage for the two screens' decision logic, exercised
// through the exact pure helpers they call — no fragile RN component rendering.
//
//  * Results screen entry card  -> goldProspectEnabled(sub) && isGoldProspectHost(labels)
//  * Prospect Evaluation screen -> detectGoldHost + geology resolution + evaluateGoldProspect
import { isGoldProspectHost, detectGoldHost, evaluateGoldProspect, EMPTY_ANSWERS } from "./goldProspect";
import { regionalGeologyContext, geologyByPlace, type GeologyContext } from "./goldGeology";
import { goldProspectEnabled } from "./entitlements";
import type { SubscriptionStatus, SubscriptionTier } from "./subscription";

const L = (en: string) => en;

function makeSub(tier: SubscriptionTier): SubscriptionStatus {
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
    },
    deepScan: { allowance: 0, used: 0, purchased: 0, remaining: 0 },
  };
}

// Mirrors the JSX guard `goldProspectEnabled(sub) && showGoldProspect`.
function entryCardVisible(tier: SubscriptionTier, labels: string[]): boolean {
  return goldProspectEnabled(makeSub(tier)) && isGoldProspectHost(labels);
}

describe("results entry card gating", () => {
  it("shows only for the entitled tier AND a gold-host result", () => {
    expect(entryCardVisible("professional", ["Quartz vein"])).toBe(true);
    expect(entryCardVisible("professional", ["Diamond"])).toBe(false); // not a gold host
    expect(entryCardVisible("premium", ["Quartz vein"])).toBe(false); // not entitled
    expect(entryCardVisible("free", ["Pyrite"])).toBe(false);
  });
});

// Mirrors the screen's geology resolution: GPS first, else typed country,
// else null (empty state).
function resolveGeology(
  location: { lat: number; lng: number } | null,
  answers: { country?: string; region?: string; district?: string },
): GeologyContext | null {
  if (location) return regionalGeologyContext(location.lat, location.lng, L, false);
  return geologyByPlace(answers, L, false);
}

describe("prospect evaluation screen pipeline", () => {
  it("detects the host and produces a full report with GPS geology", () => {
    const labels = ["Quartz vein"];
    expect(detectGoldHost(labels)).not.toBeNull();
    const geology = resolveGeology({ lat: 10.5, lng: 47.0 }, {});
    expect(geology?.resolvedBy).toBe("gps");
    const report = evaluateGoldProspect(
      { labels, confidencePct: 82, answers: EMPTY_ANSWERS, geology: geology ?? undefined },
      L,
    )!;
    expect(report.score).toBeGreaterThan(0);
    expect(report.nextSteps.length).toBeGreaterThan(0);
  });

  it("falls back to the typed country when there is no GPS", () => {
    const geology = resolveGeology(null, { country: "Ghana" });
    expect(geology?.resolvedBy).toBe("manual");
    expect(geology?.favorable).toBe(true);
  });

  it("resolves to null (empty state) when neither GPS nor country is available", () => {
    expect(resolveGeology(null, {})).toBeNull();
  });

  it("still evaluates when geology is absent (host-rock-only score)", () => {
    const report = evaluateGoldProspect({ labels: ["Pyrite"], confidencePct: 70, answers: EMPTY_ANSWERS }, L)!;
    expect(report).not.toBeNull();
    expect(report.evidenceFor.length).toBeGreaterThan(0);
  });
});
