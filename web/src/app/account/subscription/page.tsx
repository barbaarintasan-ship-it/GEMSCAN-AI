import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import { Alert } from "@/components/Alert";
import { PLANS, getPlan, type PlanId } from "@/lib/plans";
import { startCheckout } from "./actions";

export const metadata = { title: "Manage subscription" };

export default async function SubscriptionPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; error?: string }>;
}) {
  const { status, error } = await searchParams;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?redirect=/account/subscription");

  const { data: subscription } = await supabase
    .from("subscriptions")
    .select("tier, status, current_period_end, source")
    .eq("user_id", user.id)
    .maybeSingle();

  const currentTier = (subscription?.tier ?? "free") as PlanId;
  const currentPlan = getPlan(currentTier);
  const hasPaidPlan = currentTier !== "free";

  return (
    <section className="container section" style={{ maxWidth: 900 }}>
      <Link href="/account" className="muted" style={{ fontSize: 14 }}>
        &larr; Back to account
      </Link>
      <h1 style={{ fontSize: "2rem", marginTop: 8 }}>Manage subscription</h1>

      {status === "success" ? (
        <Alert kind="success">
          Payment received — thank you! Your plan will update within a moment as we confirm the
          payment.
        </Alert>
      ) : null}
      {status === "canceled" ? (
        <Alert kind="info">Checkout canceled. No charge was made.</Alert>
      ) : null}
      {status === "pending" ? (
        <Alert kind="info">
          Approve the payment prompt on your phone. Your plan will update automatically once the
          provider confirms it.
        </Alert>
      ) : null}
      {error ? <Alert kind="error">{error}</Alert> : null}

      <div className="card card-hi" style={{ marginTop: 16 }}>
        <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <span className="muted" style={{ fontSize: 13 }}>
              Current plan
            </span>
            <div style={{ fontSize: "1.5rem", fontWeight: 700 }}>{currentPlan?.name ?? "Free"}</div>
          </div>
          <div className="badge">{subscription?.status ?? "active"}</div>
        </div>
        {subscription?.current_period_end ? (
          <p className="muted" style={{ fontSize: 13, marginTop: 8 }}>
            {currentTier === "lifetime"
              ? "Lifetime access — no renewal."
              : `Renews / expires ${new Date(subscription.current_period_end).toLocaleDateString()}`}
          </p>
        ) : null}
        {subscription?.source ? (
          <p className="muted" style={{ fontSize: 12 }}>
            Paid via {subscription.source.replace(/_/g, " ")}
          </p>
        ) : null}
      </div>

      <h2 style={{ fontSize: "1.35rem", marginTop: 28 }}>
        {hasPaidPlan ? "Change plan" : "Upgrade"}
      </h2>
      <div className="grid grid-3" style={{ marginTop: 12 }}>
        {PLANS.filter((p) => p.id !== "free").map((plan) => {
          const isCurrent = plan.id === currentTier;
          return (
            <div key={plan.id} className={`card${plan.highlighted ? " card-hi" : ""}`}>
              <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
                <h3 style={{ fontSize: "1.15rem", margin: 0 }}>{plan.name}</h3>
                <div>
                  <strong>{plan.price}</strong>{" "}
                  <span className="muted" style={{ fontSize: 12 }}>
                    {plan.cadence}
                  </span>
                </div>
              </div>
              <p className="muted" style={{ fontSize: 13 }}>
                {plan.tagline}
              </p>
              <ul className="feature-list">
                {plan.features.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
              {isCurrent ? (
                <button className="btn btn-outline btn-block" type="button" disabled>
                  Current plan
                </button>
              ) : plan.purchasable ? (
                <div className="stack">
                  <form action={startCheckout}>
                    <input type="hidden" name="plan" value={plan.id} />
                    <button className="btn btn-primary btn-block" type="submit">
                      Pay by card
                    </button>
                  </form>
                  <Link
                    href={`/checkout/mobile-money?plan=${plan.id}`}
                    className="btn btn-outline btn-block"
                  >
                    Pay by mobile money
                  </Link>
                </div>
              ) : (
                <Link href="/pricing#professional" className="btn btn-outline btn-block">
                  Contact sales
                </Link>
              )}
            </div>
          );
        })}
      </div>

      <p className="disclaimer" style={{ marginTop: 28 }}>
        GemScan AI provides AI-assisted identification for educational and informational purposes
        only. It is not a certified appraisal and should not be relied upon for insurance,
        resale, or legal valuation.
      </p>
    </section>
  );
}
