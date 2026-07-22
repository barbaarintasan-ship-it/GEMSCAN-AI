// useSubscriptionStatus
//
// This hook is the ONLY way any screen in the app checks entitlement. It
// calls the backend's verify-subscription Edge Function — never a local
// cached flag alone, and never any App Store / Play Store receipt API
// (because none exist in this app; see /05-Monetization-Legal-Payments.md).
//
// The app never purchases anything here — it only reads what the website
// checkout has already granted, server-side.
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "./auth";

export type SubscriptionTier = "free" | "premium" | "lifetime" | "professional";

export type SubscriptionFeatures = {
  // Standard Scan = one cheap AI model; capped per day only to stop abuse.
  standardScanDailyLimit: number | null;
  // Deep Scan = the expensive 3-AI ensemble, included per period (metered).
  deepScanAllowance: number;
  askAGemologist: boolean;
  inventoryManagement: boolean;
  pdfReports: boolean;
  batchScanning: boolean;
  // Dedicated entitlement for Gold Prospect Evaluation. Optional because the
  // backend does not send it yet; when absent, lib/entitlements.ts derives it
  // from the tier so behavior is unchanged. See goldProspectEnabled().
  goldProspectEvaluation?: boolean;
};

// Deep Scan balance the app DISPLAYS (read-only). Purchases happen on the
// website only — the app never mutates these numbers.
export type DeepScanBalance = {
  allowance: number; // included this period
  used: number; // allowance-covered Deep Scans used this period
  purchased: number; // rolled-over purchased credits
  remaining: number; // allowance-remaining + purchased
};

export type SubscriptionStatus = {
  tier: SubscriptionTier;
  status: "active" | "past_due" | "canceled" | "expired";
  currentPeriodEnd: string | null;
  source: string | null;
  features: SubscriptionFeatures;
  deepScan: DeepScanBalance;
};

const EMPTY_DEEP_SCAN: DeepScanBalance = { allowance: 0, used: 0, purchased: 0, remaining: 0 };

const FUNCTIONS_URL = process.env.EXPO_PUBLIC_SUPABASE_FUNCTIONS_URL!;

async function fetchSubscriptionStatus(accessToken: string): Promise<SubscriptionStatus> {
  const res = await fetch(`${FUNCTIONS_URL}/verify-subscription`, {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `verify-subscription failed with status ${res.status}`);
  }

  const json = (await res.json()) as SubscriptionStatus;
  // Default the balance so older backends (pre-credits) never crash the app.
  return { ...json, deepScan: json.deepScan ?? EMPTY_DEEP_SCAN };
}

export function useSubscriptionStatus() {
  const { session } = useAuth();

  return useQuery<SubscriptionStatus>({
    queryKey: ["subscription-status", session?.user.id],
    queryFn: () => fetchSubscriptionStatus(session!.access_token),
    enabled: Boolean(session?.access_token),
    // Entitlement can change server-side at any moment (e.g. a website
    // purchase completes while the app is open), so refetch reasonably
    // often and whenever the app regains focus rather than trusting a
    // long-lived cache.
    staleTime: 60 * 1000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
}
