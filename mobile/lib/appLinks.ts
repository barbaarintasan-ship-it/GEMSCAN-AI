// Central place for the outbound website links, so every "Upgrade / Subscribe"
// action points to the same page and can be changed via one env var.
export const PAYMENT_URL =
  process.env.EXPO_PUBLIC_PAYMENT_URL ?? "https://barbaarintasan.com/gemscanpayment";

// Placeholder destination for the $5 High-Value Verification Report paywall
// (see app/(app)/scan/verify.tsx). Same "app never charges anyone" rule as
// PAYMENT_URL above — this only ever gets opened via Linking.openURL(), never
// called from within the app.
export const HIGH_VALUE_REPORT_PAYMENT_URL =
  process.env.EXPO_PUBLIC_HIGH_VALUE_REPORT_PAYMENT_URL ??
  "https://barbaarintasan.com/gemscan-report-payment";

// `purchaseId` is the high_value_report_purchases row id — the reference the
// website page (and eventually the payment gateway webhook) uses to mark that
// specific report as paid.
export function buildHighValueReportPaymentUrl(purchaseId: string, method: "mobile" | "card"): string {
  return `${HIGH_VALUE_REPORT_PAYMENT_URL}?ref=${encodeURIComponent(purchaseId)}&method=${method}`;
}

// Placeholder destination for the $5 Gold Verification Report paywall (see
// app/(app)/scan/verify-gold.tsx) — a separate page/plugin from the report
// above, same "app never charges anyone" rule.
export const GOLD_REPORT_PAYMENT_URL =
  process.env.EXPO_PUBLIC_GOLD_REPORT_PAYMENT_URL ??
  "https://barbaarintasan.com/gemscan-gold-report-payment";

// `purchaseId` is the gold_report_purchases row id.
export function buildGoldReportPaymentUrl(purchaseId: string, method: "mobile" | "card"): string {
  return `${GOLD_REPORT_PAYMENT_URL}?ref=${encodeURIComponent(purchaseId)}&method=${method}`;
}

// Destination for the $10 Artifact Verification Report paywall (see
// app/(app)/scan/verify-artifact.tsx) — its own page/plugin, same "app never
// charges anyone" rule. The live WordPress page uses the slug
// `artifact-verification-report`.
export const ARTIFACT_REPORT_PAYMENT_URL =
  process.env.EXPO_PUBLIC_ARTIFACT_REPORT_PAYMENT_URL ??
  "https://barbaarintasan.com/artifact-verification-report";

// `purchaseId` is the artifact_report_purchases row id.
export function buildArtifactReportPaymentUrl(purchaseId: string, method: "mobile" | "card"): string {
  return `${ARTIFACT_REPORT_PAYMENT_URL}?ref=${encodeURIComponent(purchaseId)}&method=${method}`;
}

// GemScan intentionally sells its plans/reports on the website only (no in-app
// purchase of digital content). BOTH stores restrict surfacing external-purchase
// UI or steering users to it from inside the app — Apple Guideline 3.1.1 and
// Google Play's Payments / anti-steering rules. So this is now false on EVERY
// platform: the app shows NO price, "Buy" button, or "subscribe on our website"
// wording anywhere. Entitlement already bought on the website is still read and
// honored (see verify-subscription) — the app simply never sells.
//
// Flip to a real in-app purchase (StoreKit / Google Play Billing) flow if store
// billing is ever added.
export const EXTERNAL_PURCHASES_ENABLED = false;

// True when a scan failed because the free-tier daily limit was reached — used
// to show an upgrade prompt instead of a raw error.
export function isScanLimitError(message?: string | null): boolean {
  if (!message) return false;
  const m = message.toLowerCase();
  return m.includes("scan limit") || m.includes("daily scan") || m.includes("free tier");
}
