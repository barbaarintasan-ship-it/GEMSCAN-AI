import Link from "next/link";
import { PLANS, PAYMENT_RAILS } from "@/lib/plans";

export const metadata = {
  title: "Pricing",
  description: "Simple, honest pricing for GemScan AI — start free, upgrade for unlimited Deep Scans.",
};

export default function PricingPage() {
  return (
    <section className="container section">
      <div className="center">
        <div className="badge">Pricing</div>
        <h1 style={{ fontSize: "2.4rem", marginTop: 12 }}>Start free. Upgrade when you need more.</h1>
        <p className="muted" style={{ maxWidth: 560, margin: "8px auto 0" }}>
          Every plan runs the same honest AI. Paid plans unlock unlimited scans and the multi-model
          Deep Scan ensemble.
        </p>
      </div>

      <div className="grid grid-2" style={{ marginTop: 32 }}>
        {PLANS.map((plan) => (
          <div
            key={plan.id}
            id={plan.id}
            className={`card${plan.highlighted ? " card-hi" : ""}`}
          >
            {plan.highlighted ? <div className="badge">Most popular</div> : null}
            <h2 style={{ fontSize: "1.4rem", marginTop: plan.highlighted ? 12 : 0 }}>{plan.name}</h2>
            <div style={{ margin: "8px 0" }}>
              <span style={{ fontSize: "2rem", fontWeight: 700 }}>{plan.price}</span>{" "}
              <span className="muted">{plan.cadence}</span>
            </div>
            <p className="muted">{plan.tagline}</p>
            <ul className="feature-list">
              {plan.features.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
            {plan.id === "free" ? (
              <Link href="/signup" className="btn btn-outline btn-block">
                Create free account
              </Link>
            ) : plan.purchasable ? (
              <Link
                href={`/account/subscription`}
                className={`btn btn-block ${plan.highlighted ? "btn-primary" : "btn-outline"}`}
              >
                Choose {plan.name}
              </Link>
            ) : (
              <a href="mailto:support@gemscan.ai" className="btn btn-outline btn-block">
                Contact sales
              </a>
            )}
          </div>
        ))}
      </div>

      <div className="card" style={{ marginTop: 28 }}>
        <h2 style={{ fontSize: "1.2rem", marginTop: 0 }}>Ways to pay</h2>
        <p className="muted">
          Cards: {PAYMENT_RAILS.card.join(", ")}.
        </p>
        <p className="muted">
          Mobile money: {PAYMENT_RAILS.mobileMoney.map((m) => m.label).join(", ")}.
        </p>
        <p className="muted" style={{ fontSize: 13 }}>
          All payments are handled on the website. The mobile app never processes payments.
        </p>
      </div>

      <p className="disclaimer" style={{ marginTop: 28 }}>
        GemScan AI provides AI-assisted identification for educational and informational purposes
        only. It is not a certified appraisal and should not be relied upon for insurance, resale,
        or legal valuation.
      </p>
    </section>
  );
}
