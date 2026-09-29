import { Platform } from "react-native";

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
export function buildHighValueReportPaymentUrl(purchaseId: string, method?: "mobile" | "card"): string {
  const base = `${HIGH_VALUE_REPORT_PAYMENT_URL}?ref=${encodeURIComponent(purchaseId)}`;
  // method is optional — the website shows/handles the payment-method choice, so
  // the app no longer presents "Mobile Pay / Card Pay" in-app.
  return method ? `${base}&method=${method}` : base;
}

// Placeholder destination for the $5 Gold Verification Report paywall (see
// app/(app)/scan/verify-gold.tsx) — a separate page/plugin from the report
// above, same "app never charges anyone" rule.
export const GOLD_REPORT_PAYMENT_URL =
  process.env.EXPO_PUBLIC_GOLD_REPORT_PAYMENT_URL ??
  "https://barbaarintasan.com/gemscan-gold-report-payment";

// `purchaseId` is the gold_report_purchases row id.
export function buildGoldReportPaymentUrl(purchaseId: string, method?: "mobile" | "card"): string {
  const base = `${GOLD_REPORT_PAYMENT_URL}?ref=${encodeURIComponent(purchaseId)}`;
  return method ? `${base}&method=${method}` : base;
}

// Destination for the $10 Artifact Verification Report paywall (see
// app/(app)/scan/verify-artifact.tsx) — its own page/plugin, same "app never
// charges anyone" rule. The live WordPress page uses the slug
// `artifact-verification-report`.
export const ARTIFACT_REPORT_PAYMENT_URL =
  process.env.EXPO_PUBLIC_ARTIFACT_REPORT_PAYMENT_URL ??
  "https://barbaarintasan.com/artifact-verification-report";

// `purchaseId` is the artifact_report_purchases row id.
export function buildArtifactReportPaymentUrl(purchaseId: string, method?: "mobile" | "card"): string {
  const base = `${ARTIFACT_REPORT_PAYMENT_URL}?ref=${encodeURIComponent(purchaseId)}`;
  return method ? `${base}&method=${method}` : base;
}

// LuulScan sells its plans/reports on the website only. The app shows a
// price-less "unlock on the website" call-to-action that opens the checkout
// page; after paying there, entitlement unlocks automatically (read via
// verify-subscription). NO price is ever displayed in-app.
//
// iOS stays OFF: Apple Guideline 3.1.1 forbids steering to an external purchase
// at all, so no upgrade CTA is shown on iOS. Android/web keep the price-less
// website CTA. (Google Play's anti-steering rules are looser and, post-2024
// rulings, increasingly permit external-payment links.)
export const EXTERNAL_PURCHASES_ENABLED = Platform.OS !== "ios";

// The server code that means "standard-scan allowance exhausted" (daily abuse
// cap OR free lifetime cap). Returned by orchestrate-scan with HTTP 429 and
// carried on OrchestrationError.code — the authoritative, wording-independent
// signal. Kept as a named constant so client and tests agree on the string.
export const STANDARD_LIMIT_REACHED_CODE = "standard_limit_reached";

// True when a scan was blocked because the standard-scan allowance is used up —
// used to show the upgrade/paywall card instead of a raw error.
//
// Prefers the machine-readable error CODE when given the error object (robust
// to any server-message wording change); falls back to matching the human
// message when only a string is available (e.g. a render path that stored
// err.message). The message match covers BOTH the daily wording ("...Standard
// Scan limit reached...") and the lifetime wording ("...used all of your free
// lifetime scans...") so the paywall shows for either.
export function isScanLimitError(
  input?: string | { code?: string | null; message?: string | null } | null,
): boolean {
  if (input == null) return false;
  if (typeof input !== "string") {
    if (input.code === STANDARD_LIMIT_REACHED_CODE) return true;
    return matchesScanLimitMessage(input.message);
  }
  return matchesScanLimitMessage(input);
}

function matchesScanLimitMessage(message?: string | null): boolean {
  if (!message) return false;
  const m = message.toLowerCase();
  return (
    m.includes("scan limit") || // "...Standard Scan limit reached..." (daily)
    m.includes("daily scan") ||
    m.includes("free tier") ||
    m.includes("lifetime scan") || // "...free lifetime scans..." (lifetime)
    m.includes("free lifetime")
  );
}
