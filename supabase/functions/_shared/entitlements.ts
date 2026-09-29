// Shared entitlement derivation, used by verify-subscription (so the app can
// display what's unlocked) AND orchestrate-scan (so scan-time enforcement is
// server-side, not just a UI hint). Single source of truth for "what does each
// tier unlock" — see 05-Monetization-Legal-Payments.md for the pricing.
//
// COST MODEL (why this shape):
//   - Standard Scan  = ONE cost-efficient AI model (Gemini). On PAID tiers it
//     is allowed generously and capped per-day only to stop abuse. On the FREE
//     tier it is a lifetime trial: a fixed total of scans that never resets
//     (see standardScanLimitPeriod).
//   - Deep Scan      = the full 3-AI ensemble (Gemini + OpenAI + Claude). This
//     is the expensive path, so it is METERED with credits, never unlimited.
//       * deepScanAllowance = Deep Scans included per subscription period.
//       * beyond that, users spend PURCHASED credits (deep_scan_credits table).
//   There is intentionally NO "ensembleScans: true" flag any more — nothing
//   grants unlimited ensemble access.
export type SubscriptionFeatures = {
  // The Standard Scan cap. null = unlimited (abuse guard only). Its meaning is
  // set by standardScanLimitPeriod: a per-UTC-day cap ("day") or a never-
  // resetting lifetime total ("lifetime"). Kept named *DailyLimit for backward
  // compatibility with the mobile SubscriptionFeatures type and older backends.
  standardScanDailyLimit: number | null;
  // "day": standardScanDailyLimit resets every UTC midnight (paid tiers).
  // "lifetime": it is a total that never resets (free tier). Optional so an
  // older backend that predates this field is read as "day" — exactly its
  // behavior before the field existed. Mirrors mobile/lib/subscription.ts.
  standardScanLimitPeriod?: "day" | "lifetime";
  deepScanAllowance: number; // included Deep Scans per subscription period
  askAGemologist: boolean;
  inventoryManagement: boolean;
  pdfReports: boolean;
  batchScanning: boolean;
};

// Practically-unlimited Deep Scan allowance for owner/operator accounts (still
// tracked in scan_usage, just never blocked). Kept finite so all the counting
// code paths stay identical.
export const OWNER_DEEP_SCAN_ALLOWANCE = 1_000_000;

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
    case "professional": // Gem Collector — $14.99 / 6 months
      return {
        standardScanDailyLimit: 100, // generous; abuse guard only
        deepScanAllowance: 100, // included Deep Scans per 6-month period
        askAGemologist: true,
        inventoryManagement: true,
        pdfReports: true,
        batchScanning: true,
      };
    case "lifetime":
    case "premium": // Explorer — $4.99 / 6 months
      return {
        standardScanDailyLimit: 30,
        deepScanAllowance: 20,
        askAGemologist: true,
        inventoryManagement: false,
        pdfReports: false,
        batchScanning: false,
      };
    case "free":
    default:
      return {
        // Free tier is a lifetime trial: 10 Standard scans total, ever — it
        // does NOT reset daily. Enforced server-side against the all-time
        // scan_usage ledger (see consume_standard_scan / orchestrate-scan).
        standardScanDailyLimit: 10,
        standardScanLimitPeriod: "lifetime",
        deepScanAllowance: 0, // no included Deep Scans (can buy credits)
        askAGemologist: false,
        inventoryManagement: false,
        pdfReports: false,
        batchScanning: false,
      };
  }
}

/**
 * Deep Scan allowance for a caller, applying the owner override. Owners are
 * effectively unlimited (still logged), everyone else gets their tier's
 * included allowance.
 */
export function deepScanAllowanceFor(
  email: string | null | undefined,
  tier: string,
): number {
  if (isOwnerEmail(email)) return OWNER_DEEP_SCAN_ALLOWANCE;
  return featuresForTier(tier).deepScanAllowance;
}
