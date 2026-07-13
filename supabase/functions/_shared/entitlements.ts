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

// Owner / admin accounts. These are the app operators' OWN accounts: always
// fully entitled ("professional"), never billed, and never expiring. The grant
// is by email and checked server-side, so it does NOT depend on a subscriptions
// row, a Stripe/PayPal record, or a period-end date — there is nothing to lapse
// or to charge. It takes effect the moment the account signs in. Compared
// case-insensitively. Add/remove operator emails here.
export const OWNER_EMAILS: ReadonlySet<string> = new Set([
  "awmusse.musse@gmail.com",
]);

export function isOwnerEmail(email: string | null | undefined): boolean {
  return email != null && OWNER_EMAILS.has(email.trim().toLowerCase());
}

// Single source of truth for turning (caller email + their subscriptions row)
// into the effective tier. Owner accounts are forced to "professional"
// (unlimited + every feature); everyone else gets their active subscription
// tier, or "free" when there is no active subscription.
export function resolveEffectiveTier(
  email: string | null | undefined,
  subscription: { tier?: string | null; status?: string | null } | null | undefined,
): string {
  if (isOwnerEmail(email)) return "professional";
  return subscription?.status === "active" ? (subscription.tier ?? "free") : "free";
}

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
