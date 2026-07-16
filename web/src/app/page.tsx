import Link from "next/link";
import { PLANS } from "@/lib/plans";

export default function HomePage() {
  return (
    <>
      {/* Hero */}
      <section className="container hero">
        <span className="badge">Honest multi-model AI</span>
        <h1 style={{ marginTop: 16 }}>
          Identify any gemstone, mineral, or piece of jewelry
          <span className="gold"> in seconds.</span>
        </h1>
        <p className="lead">
          Point your phone at a specimen and GemScan AI runs a live, on-device scan plus a
          multi-model AI ensemble in the cloud — then tells you honestly how confident it is.
        </p>
        <div className="row" style={{ marginTop: 24 }}>
          <Link href="/download" className="btn btn-primary">
            Get the app
          </Link>
          <Link href="/pricing" className="btn btn-outline">
            See pricing
          </Link>
        </div>
        <p className="disclaimer">
          Not a certified appraisal. GemScan AI provides AI estimates, not lab-grade valuations.
        </p>
      </section>

      {/* Features */}
      <section className="container section">
        <div className="grid grid-3">
          <div className="card">
            <h3>Live AI Scanner</h3>
            <p>
              A Google-Lens-style live camera experience with real-time guidance, auto multi-angle
              capture, and an intelligent auto-lock when confidence is high.
            </p>
          </div>
          <div className="card">
            <h3>Multi-model ensemble</h3>
            <p>
              Deep Scan fans out to several vision models and weighs them into one ranked, honest
              verdict — including telling you when it&apos;s not sure.
            </p>
          </div>
          <div className="card">
            <h3>Built for pros too</h3>
            <p>
              Jewelers and pawn shops get inventory management, PDF reports, and batch scanning on
              the Professional tier.
            </p>
          </div>
        </div>
      </section>

      {/* Pricing preview */}
      <section className="container section">
        <div className="center" style={{ marginBottom: 28 }}>
          <h2>Simple, honest pricing</h2>
          <p>Pay on the web. Unlock everything in the app. No app-store markup.</p>
        </div>
        <div className="grid grid-3">
          {PLANS.map((plan) => (
            <div key={plan.id} className={`card ${plan.highlighted ? "card-hi" : ""}`}>
              {plan.highlighted && <span className="badge">Most popular</span>}
              <h3 style={{ marginTop: plan.highlighted ? 12 : 0 }}>{plan.name}</h3>
              <div style={{ fontSize: 28, fontWeight: 800 }}>
                {plan.price}{" "}
                <span className="muted" style={{ fontSize: 14, fontWeight: 400 }}>
                  {plan.cadence}
                </span>
              </div>
              <p style={{ fontSize: 14 }}>{plan.tagline}</p>
            </div>
          ))}
        </div>
        <div className="center" style={{ marginTop: 28 }}>
          <Link href="/pricing" className="btn btn-primary">
            Compare all plans
          </Link>
        </div>
      </section>
    </>
  );
}
