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
  dailyScanLimit: number | null;
  ensembleScans: boolean;
  askAGemologist: boolean;
  inventoryManagement: boolean;
  pdfReports: boolean;
  batchScanning: boolean;
};

export type SubscriptionStatus = {
  tier: SubscriptionTier;
  status: "active" | "past_due" | "canceled" | "expired";
  currentPeriodEnd: string | null;
  source: string | null;
  features: SubscriptionFeatures;
};

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

  return res.json();
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
