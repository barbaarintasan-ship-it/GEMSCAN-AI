import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import { Alert } from "@/components/Alert";
import { PAYMENT_RAILS, getPlan, type PlanId } from "@/lib/plans";
import { startMobileMoney } from "./actions";

export const metadata = { title: "Pay with mobile money" };

export default async function MobileMoneyCheckoutPage({
  searchParams,
}: {
  searchParams: Promise<{ plan?: string; error?: string }>;
}) {
  const { plan: planParam, error } = await searchParams;
  const plan = getPlan((planParam ?? "") as PlanId);

  if (!plan || !plan.purchasable) {
    redirect("/account/subscription?error=Choose a plan to continue.");
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect(`/login?redirect=/checkout/mobile-money?plan=${plan.id}`);

  return (
    <section className="container section" style={{ maxWidth: 480 }}>
      <Link href="/account/subscription" className="muted" style={{ fontSize: 14 }}>
        &larr; Back
      </Link>
      <h1 style={{ fontSize: "1.75rem", marginTop: 8 }}>Pay with mobile money</h1>
      <p className="muted">
        {plan.name} — <strong>{plan.price}</strong> {plan.cadence}
      </p>

      {error ? <Alert kind="error">{error}</Alert> : null}

      <form action={startMobileMoney} className="card" style={{ marginTop: 12 }}>
        <input type="hidden" name="plan" value={plan.id} />
        <div className="field">
          <label htmlFor="provider">Provider</label>
          <select className="input" id="provider" name="provider" required>
            {PAYMENT_RAILS.mobileMoney.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="phone">Mobile money number</label>
          <input
            className="input"
            id="phone"
            name="phone"
            type="tel"
            inputMode="tel"
            placeholder="+252 ..."
            required
          />
          <span className="muted" style={{ fontSize: 12 }}>
            You&apos;ll receive a payment prompt on this number to approve.
          </span>
        </div>
        <button className="btn btn-primary btn-block" type="submit">
          Send payment request
        </button>
      </form>

      <p className="disclaimer" style={{ marginTop: 20 }}>
        Your subscription activates automatically once the payment is confirmed by the provider.
      </p>
    </section>
  );
}
