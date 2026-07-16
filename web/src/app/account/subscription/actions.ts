"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import { functionsUrl } from "@/lib/config";
import { getPlan, type PlanId } from "@/lib/plans";

// Start a Stripe checkout for a purchasable plan. We never touch Stripe from the
// browser or duplicate any billing logic here — we simply call the existing
// shared `create-checkout-session` Edge Function with the user's JWT and
// redirect to the hosted Checkout URL it returns. The subscriptions table is
// only ever written by the stripe-webhook (service role), not by this flow.
export async function startCheckout(formData: FormData) {
  const plan = String(formData.get("plan") ?? "") as PlanId;

  const target = getPlan(plan);
  if (!target || !target.purchasable) {
    redirect("/account/subscription?error=That plan can't be purchased here.");
  }

  const supabase = await createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) redirect("/login?redirect=/account/subscription");

  if (!functionsUrl) {
    redirect("/account/subscription?error=Checkout is not configured. Please contact support.");
  }

  let checkoutUrl: string | null = null;
  try {
    const res = await fetch(`${functionsUrl}/create-checkout-session`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ plan }),
    });

    if (res.ok) {
      const data = (await res.json()) as { url?: string };
      checkoutUrl = data.url ?? null;
    }
  } catch {
    checkoutUrl = null;
  }

  if (!checkoutUrl) {
    redirect("/account/subscription?error=Could not start checkout. Please try again.");
  }

  redirect(checkoutUrl);
}
