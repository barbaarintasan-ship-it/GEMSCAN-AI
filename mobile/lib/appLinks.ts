import { Platform } from "react-native";

// Central place for the outbound website links, so every "Upgrade / Subscribe"
// action points to the same page and can be changed via one env var.
export const PAYMENT_URL =
  process.env.EXPO_PUBLIC_PAYMENT_URL ?? "https://barbaarintasan.com/gemscanpayment";

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
