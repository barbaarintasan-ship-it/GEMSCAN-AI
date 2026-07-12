// create-checkout-session
//
// WEBSITE-ONLY endpoint. This function creates a Stripe Checkout Session and
// is meant to be called exclusively from the official website's backend/
// frontend during a logged-in user's upgrade flow. The mobile app must NEVER
// call this endpoint — there is intentionally no client SDK wiring for it
// anywhere in the mobile app codebase (see mobile/lib, which only contains
// verify-subscription usage).
//
// Request:  POST, Authorization: Bearer <user JWT>, body: { plan: "premium" | "lifetime" | "professional" }
// Response: { url: string } — the Stripe-hosted Checkout page to redirect to.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import Stripe from "https://esm.sh/stripe@14?target=deno";
import { corsHeaders } from "../_shared/cors.ts";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2023-10-16",
  httpClient: Stripe.createFetchHttpClient(),
});

const PLAN_TO_PRICE: Record<string, string> = {
  premium: Deno.env.get("STRIPE_PRICE_PREMIUM_YEARLY") ?? "",
  lifetime: Deno.env.get("STRIPE_PRICE_LIFETIME") ?? "",
  professional: Deno.env.get("STRIPE_PRICE_PROFESSIONAL") ?? "",
};

// Restrict which origins may initiate checkout — the official website only.
// Adjust to the real production domain before launch.
const ALLOWED_ORIGIN = Deno.env.get("WEBSITE_ORIGIN") ?? "https://gemscan.ai";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const origin = req.headers.get("Origin");
  if (origin && origin !== ALLOWED_ORIGIN) {
    return new Response(JSON.stringify({ error: "Origin not allowed" }), {
      status: 403,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing Authorization header" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );

    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();

    if (userError || !user) {
      return new Response(JSON.stringify({ error: "Invalid or expired session" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { plan } = await req.json();
    const priceId = PLAN_TO_PRICE[plan];
    if (!priceId) {
      return new Response(JSON.stringify({ error: `Unknown plan: ${plan}` }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const isSubscription = plan === "premium"; // lifetime/professional use one-time or custom invoicing

    const session = await stripe.checkout.sessions.create({
      mode: isSubscription ? "subscription" : "payment",
      payment_method_types: ["card"],
      line_items: [{ price: priceId, quantity: 1 }],
      // Ties the Stripe session back to our Supabase user without ever
      // needing Stripe to know about app-store identities — this is the
      // link the stripe-webhook function uses to update the right row.
      client_reference_id: user.id,
      customer_email: user.email,
      subscription_data: isSubscription
        ? { metadata: { supabase_user_id: user.id } }
        : undefined,
      success_url: `${ALLOWED_ORIGIN}/account/subscription?status=success`,
      cancel_url: `${ALLOWED_ORIGIN}/pricing?status=canceled`,
    });

    return new Response(JSON.stringify({ url: session.url }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
