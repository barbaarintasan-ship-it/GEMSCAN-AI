// stripe-webhook
//
// Receives events directly from Stripe (server-to-server). This is the ONLY
// way the `subscriptions` table is ever written to for Stripe-sourced plans —
// there is no client-callable "set my subscription" endpoint anywhere in this
// codebase, mobile or web. The mobile app never calls this function and has
// no knowledge of its existence.
//
// Configure in the Stripe Dashboard: webhook URL -> this function's URL,
// events: checkout.session.completed, customer.subscription.updated,
// customer.subscription.deleted, invoice.payment_failed.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import Stripe from "https://esm.sh/stripe@14?target=deno";
import { logError } from "../_shared/logger.ts";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2023-10-16",
  httpClient: Stripe.createFetchHttpClient(),
});

const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET")!;

// service_role client — required to write to `subscriptions`, since the
// table's RLS policies grant authenticated users read-only access to their
// own row and grant no write access to anyone but service_role.
const supabaseAdmin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

// Maps a Stripe Price ID to our internal tier name. Configure these to match
// the actual Price IDs created in the Stripe Dashboard for the $25/yr premium
// and $75 lifetime plans (professional tier priced/negotiated separately,
// see 05-Monetization-Legal-Payments.md).
const PRICE_TO_TIER: Record<string, "premium" | "lifetime" | "professional"> = {
  [Deno.env.get("STRIPE_PRICE_PREMIUM_YEARLY") ?? ""]: "premium",
  [Deno.env.get("STRIPE_PRICE_LIFETIME") ?? ""]: "lifetime",
  [Deno.env.get("STRIPE_PRICE_PROFESSIONAL") ?? ""]: "professional",
};

async function upsertSubscription(params: {
  userId: string;
  tier: "premium" | "lifetime" | "professional";
  status: "active" | "past_due" | "canceled" | "expired";
  externalReferenceId: string;
  currentPeriodStart?: Date | null;
  currentPeriodEnd?: Date | null;
}) {
  const { error } = await supabaseAdmin
    .from("subscriptions")
    .upsert(
      {
        user_id: params.userId,
        tier: params.tier,
        status: params.status,
        source: "stripe",
        external_reference_id: params.externalReferenceId,
        current_period_start: params.currentPeriodStart?.toISOString() ?? null,
        current_period_end: params.currentPeriodEnd?.toISOString() ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" },
    );

  if (error) throw error;
}

async function logEvent(eventType: string, externalReferenceId: string | null, userId: string | null, payload: unknown) {
  await supabaseAdmin.from("payment_events").insert({
    source: "stripe",
    event_type: eventType,
    external_reference_id: externalReferenceId,
    user_id: userId,
    payload,
  });
}

Deno.serve(async (req) => {
  const signature = req.headers.get("Stripe-Signature");
  const body = await req.text();

  if (!signature) {
    return new Response("Missing Stripe-Signature header", { status: 400 });
  }

  let event: Stripe.Event;
  try {
    // Signature verification is what makes this endpoint safe to expose
    // publicly — anyone can POST to the URL, but only Stripe (holding the
    // shared webhook secret) can produce a payload that verifies.
    event = await stripe.webhooks.constructEventAsync(body, signature, webhookSecret);
  } catch (err) {
    return new Response(`Webhook signature verification failed: ${(err as Error).message}`, {
      status: 400,
    });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        // `client_reference_id` is set to our internal Supabase user id when
        // the Checkout Session is created (see create-checkout-session),
        // so we never have to match by email.
        const userId = session.client_reference_id;
        if (!userId) break;

        const lineItems = await stripe.checkout.sessions.listLineItems(session.id);
        const priceId = lineItems.data[0]?.price?.id ?? "";
        const tier = PRICE_TO_TIER[priceId] ?? "premium";

        let periodEnd: Date | null = null;
        if (session.subscription) {
          const sub = await stripe.subscriptions.retrieve(session.subscription as string);
          periodEnd = new Date(sub.current_period_end * 1000);
        }

        await upsertSubscription({
          userId,
          tier,
          status: "active",
          externalReferenceId: (session.subscription as string) ?? session.id,
          currentPeriodStart: new Date(),
          currentPeriodEnd: periodEnd,
        });
        await logEvent(event.type, session.id, userId, event.data.object);
        break;
      }

      case "customer.subscription.updated": {
        const sub = event.data.object as Stripe.Subscription;
        const userId = sub.metadata?.supabase_user_id;
        if (!userId) break;

        const priceId = sub.items.data[0]?.price?.id ?? "";
        const tier = PRICE_TO_TIER[priceId] ?? "premium";
        const status = sub.status === "active" ? "active"
          : sub.status === "past_due" ? "past_due"
          : "canceled";

        await upsertSubscription({
          userId,
          tier,
          status,
          externalReferenceId: sub.id,
          currentPeriodStart: new Date(sub.current_period_start * 1000),
          currentPeriodEnd: new Date(sub.current_period_end * 1000),
        });
        await logEvent(event.type, sub.id, userId, event.data.object);
        break;
      }

      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        const userId = sub.metadata?.supabase_user_id;
        if (!userId) break;

        await supabaseAdmin
          .from("subscriptions")
          .update({ status: "canceled", updated_at: new Date().toISOString() })
          .eq("user_id", userId);
        await logEvent(event.type, sub.id, userId, event.data.object);
        break;
      }

      default:
        // Unhandled event types are logged but not acted on.
        await logEvent(event.type, null, null, event.data.object);
    }

    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    logError("stripe-webhook", err);
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
