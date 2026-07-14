// Central place for the outbound website links, so every "Upgrade / Subscribe"
// action points to the same page and can be changed via one env var.
export const PAYMENT_URL =
  process.env.EXPO_PUBLIC_PAYMENT_URL ?? "https://barbaarintasan.com/gemscanpayment";

// True when a scan failed because the free-tier daily limit was reached — used
// to show an upgrade prompt instead of a raw error.
export function isScanLimitError(message?: string | null): boolean {
  if (!message) return false;
  const m = message.toLowerCase();
  return m.includes("scan limit") || m.includes("daily scan") || m.includes("free tier");
}
