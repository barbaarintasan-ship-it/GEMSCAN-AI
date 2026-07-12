// Shared entitlement derivation, used by verify-subscription (so the app can
// display what's unlocked) AND orchestrate-scan (so scan-time enforcement of
// daily limits / ensemble access is server-side, not just a UI hint). Single
// source of truth for "what does each tier unlock" — see 05-Monetization-
// Legal-Payments.md for the pricing this maps to.
export type SubscriptionFeatures = {
  dailyScanLimit: number | null;
  ensembleScans: boolean;
  askAGemologist: boolean;
  inventoryManagement: boolean;
  pdfReports: boolean;
  batchScanning: boolean;
};

export function featuresForTier(tier: string): SubscriptionFeatures {
  switch (tier) {
    case "professional":
      return {
        dailyScanLimit: null, // unlimited
        ensembleScans: true,
        askAGemologist: true,
        inventoryManagement: true,
        pdfReports: true,
        batchScanning: true,
      };
    case "lifetime":
    case "premium":
      return {
        dailyScanLimit: null,
        ensembleScans: true,
        askAGemologist: true,
        inventoryManagement: false,
        pdfReports: false,
        batchScanning: false,
      };
    case "free":
    default:
      return {
        dailyScanLimit: 5,
        ensembleScans: false,
        askAGemologist: false,
        inventoryManagement: false,
        pdfReports: false,
        batchScanning: false,
      };
  }
}
