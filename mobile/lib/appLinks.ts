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
export function buildHighValueReportPaymentUrl(purchaseId: string, method: "mobile" | "card"): string {
  return `${HIGH_VALUE_REPORT_PAYMENT_URL}?ref=${encodeURIComponent(purchaseId)}&method=${method}`;
}

// Apple App Store Guideline 3.1.1 forbids unlocking in-app digital content via
// an EXTERNAL purchase flow or steering users to it (buttons, links, or even
// "subscribe on our website" wording). Since GemScan intentionally sells its
// plans on the website (no Apple In-App Purchase), we must NOT surface any of
// that purchase UI inside the iOS build. On Android (and web) the website
// checkout is allowed, so the upgrade prompts stay.
//
// Flip this to a real In-App Purchase flow if/when StoreKit is added for iOS.
export const EXTERNAL_PURCHASES_ENABLED = Platform.OS !== "ios";

// True when a scan failed because the free-tier daily limit was reached — used
// to show an upgrade prompt instead of a raw error.
export function isScanLimitError(message?: string | null): boolean {
  if (!message) return false;
  const m = message.toLowerCase();
  return m.includes("scan limit") || m.includes("daily scan") || m.includes("free tier");
}
