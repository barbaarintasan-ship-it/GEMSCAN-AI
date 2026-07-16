"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import { functionsUrl } from "@/lib/config";
import { PAYMENT_RAILS, getPlan, type PlanId } from "@/lib/plans";

// Kick off a mobile-money payment. The website collects the provider + phone
// number and hands them to a shared Edge Function which talks to the payment
// gateway. Confirmation happens asynchronously via `mobile-money-webhook`
// (service role), which is the ONLY writer of the subscriptions table — this
// action never grants entitlement itself.
//
// NOTE: the initiation Edge Function (`mobile-money-checkout`) is the backend
// counterpart to the existing `mobile-money-webhook`. If it isn't deployed yet
// the user is shown a graceful "pending" message rather than an error.
export async function startMobileMoney(formData: FormData) {
  const plan = String(formData.get("plan") ?? "") as PlanId;
  const provider = String(formData.get("provider") ?? "");
  const phone = String(formData.get("phone") ?? "").trim();

  const target = getPlan(plan);
  const validProvider = PAYMENT_RAILS.mobileMoney.some((m) => m.id === provider);

  if (!target || !target.purchasable || !validProvider || !phone) {
    redirect(`/checkout/mobile-money?plan=${plan}&error=Please choose a provider and enter your number.`);
  }

  const supabase = await createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) redirect(`/login?redirect=/checkout/mobile-money?plan=${plan}`);

  if (functionsUrl) {
    try {
      const res = await fetch(`${functionsUrl}/mobile-money-checkout`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session!.access_token}`,
        },
        body: JSON.stringify({ plan, provider, phone }),
      });
      if (res.ok) {
        redirect("/account/subscription?status=pending");
      }
    } catch {
      // fall through to the pending message below
    }
  }

  redirect(
    `/account/subscription?status=pending`,
  );
}
