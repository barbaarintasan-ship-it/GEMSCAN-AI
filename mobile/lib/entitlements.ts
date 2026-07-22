// Client-side entitlement resolvers.
//
// These decouple a feature's gate from an unrelated feature flag and give it a
// single, named, testable source of truth. They only READ the subscription
// status the app already fetched (verify-subscription) — they never call the
// backend, never mutate anything, and never touch payments/credits.

import type { SubscriptionStatus } from "./subscription";

// Gold Prospect Evaluation entitlement.
//
// Dedicated flag rather than reusing `features.pdfReports`. Prefers an explicit
// backend flag when present (future-proof); otherwise derives it from the tier
// so current behavior is IDENTICAL to the old `pdfReports` gate — the
// professional ("Gem Collector") tier is the one that had pdfReports.
export function goldProspectEnabled(sub?: SubscriptionStatus | null): boolean {
  if (!sub) return false;
  if (typeof sub.features?.goldProspectEvaluation === "boolean") {
    return sub.features.goldProspectEvaluation;
  }
  return sub.tier === "professional";
}
