// Centralized runtime config for the website. Keeps env access in one place so
// the rest of the app imports typed values instead of reaching into
// process.env everywhere.

export const siteConfig = {
  name: "GemScan AI",
  description:
    "AI-powered gemstone, mineral, and jewelry identification. Scan with your phone, get an honest multi-model AI verdict.",
  // Base URL of this website (auth + checkout return URLs).
  url: process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000",
  androidUrl: process.env.NEXT_PUBLIC_ANDROID_URL || null,
  iosUrl: process.env.NEXT_PUBLIC_IOS_URL || null,
  supportEmail: "support@gemscan.ai",
};

// Server-only: base URL for calling the shared Supabase Edge Functions
// (create-checkout-session, etc.) from Next.js route handlers.
export const functionsUrl = process.env.SUPABASE_FUNCTIONS_URL ?? "";
