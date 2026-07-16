// Pricing/plan catalog for the website. This MIRRORS the backend's single
// source of truth (supabase/functions/_shared/entitlements.ts + migration
// 0001) for DISPLAY purposes only. Entitlement is always enforced server-side
// by the Edge Functions — this file never grants access, it only renders the
// marketing/pricing UI and maps a plan to the checkout call.
//
// Pricing per 05-Monetization-Legal-Payments.md:
//   Free — 5 scans/day · Premium — $25/year · Lifetime — $75 · Professional — custom.

export type PlanId = "free" | "premium" | "lifetime" | "professional";

export type Plan = {
  id: PlanId;
  name: string;
  price: string;
  cadence: string;
  tagline: string;
  features: string[];
  // Whether this plan is purchasable through the standard checkout flow.
  // Professional is custom/sales-led (bank transfer / invoice), so it links to
  // contact rather than Stripe checkout.
  purchasable: boolean;
  highlighted?: boolean;
};

export const PLANS: Plan[] = [
  {
    id: "free",
    name: "Free",
    price: "$0",
    cadence: "forever",
    tagline: "Try GemScan AI with everyday single-model scans.",
    features: [
      "5 scans per day",
      "Single-model AI identification",
      "Live Scan + Upload modes",
      "Scan history",
    ],
    purchasable: false,
  },
  {
    id: "premium",
    name: "Premium",
    price: "$25",
    cadence: "per year",
    tagline: "Unlimited Deep Scans with the full multi-model AI ensemble.",
    features: [
      "Unlimited scans",
      "Deep Scan multi-model AI ensemble",
      "Ask a Real Gemologist (per-consult)",
      "Priority processing",
    ],
    purchasable: true,
    highlighted: true,
  },
  {
    id: "lifetime",
    name: "Lifetime",
    price: "$75",
    cadence: "one-time",
    tagline: "Everything in Premium, paid once, yours forever.",
    features: [
      "Unlimited scans, forever",
      "Deep Scan multi-model AI ensemble",
      "Ask a Real Gemologist (per-consult)",
      "No recurring billing",
    ],
    purchasable: true,
  },
  {
    id: "professional",
    name: "Professional",
    price: "Custom",
    cadence: "for jewelers & pawn shops",
    tagline: "Inventory management, PDF reports, and batch scanning for teams.",
    features: [
      "Everything in Premium",
      "Inventory management",
      "PDF appraisal-style reports",
      "Batch scanning",
      "Team / multi-seat billing",
    ],
    purchasable: false,
  },
];

export function getPlan(id: PlanId): Plan | undefined {
  return PLANS.find((p) => p.id === id);
}

// Payment rails offered on the website (never in the mobile app).
export const PAYMENT_RAILS = {
  card: ["Visa", "Mastercard", "Amex", "Apple Pay (web)", "Google Pay (web)", "PayPal"],
  mobileMoney: [
    { id: "evc_plus", label: "EVC Plus (Hormuud)" },
    { id: "zaad", label: "Zaad (Telesom)" },
    { id: "sahal", label: "Sahal (Golis)" },
    { id: "edahab", label: "eDahab" },
  ],
} as const;
