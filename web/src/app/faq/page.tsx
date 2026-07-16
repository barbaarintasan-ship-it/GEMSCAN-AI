export const metadata = {
  title: "FAQ",
  description: "Frequently asked questions about GemScan AI.",
};

const FAQS: { q: string; a: string }[] = [
  {
    q: "What is GemScan AI?",
    a: "GemScan AI uses your phone camera and multiple AI models to identify gemstones, minerals, and jewelry, and to give you an honest, plain-language assessment. It is an educational and informational tool — not a certified appraisal.",
  },
  {
    q: "Is it a real appraisal?",
    a: "No. GemScan AI is not a certified appraisal and should not be relied upon for insurance, resale, or legal valuation. For those purposes, consult a certified gemologist or accredited lab.",
  },
  {
    q: "How accurate is it?",
    a: "Accuracy depends on lighting, angles, and stone quality. Deep Scan runs several AI models together and reports a confidence level so you know how sure the result is. Always treat low-confidence results with caution.",
  },
  {
    q: "What's the difference between the free and paid plans?",
    a: "Free includes 5 single-model scans per day. Premium and Lifetime unlock unlimited scans and the full multi-model Deep Scan ensemble, plus the option to ask a real gemologist.",
  },
  {
    q: "How do I pay?",
    a: "All payments are handled here on the website — by card (Visa, Mastercard, Amex, PayPal, Apple/Google Pay on web) or by mobile money (EVC Plus, Zaad, Sahal, eDahab). The mobile app never processes payments.",
  },
  {
    q: "Do my mobile app and website account share data?",
    a: "Yes. The website and mobile app share the same secure backend, so your account, subscription, and scan history stay in sync across both.",
  },
  {
    q: "How do I cancel or change my plan?",
    a: "Sign in and go to Account → Manage subscription. Lifetime is a one-time purchase with no renewal.",
  },
  {
    q: "Which languages are supported?",
    a: "English and Somali (Af-Soomaali). You can switch languages from your account profile.",
  },
];

export default function FaqPage() {
  return (
    <section className="container section" style={{ maxWidth: 760 }}>
      <div className="badge">Help</div>
      <h1 style={{ fontSize: "2.2rem", marginTop: 12 }}>Frequently asked questions</h1>

      <div className="stack" style={{ marginTop: 20, gap: 12 }}>
        {FAQS.map((item) => (
          <details key={item.q} className="card">
            <summary style={{ cursor: "pointer", fontWeight: 600 }}>{item.q}</summary>
            <p className="muted" style={{ marginBottom: 0 }}>
              {item.a}
            </p>
          </details>
        ))}
      </div>

      <p style={{ marginTop: 24 }}>
        Still stuck? Email{" "}
        <a className="gold" href="mailto:support@gemscan.ai">
          support@gemscan.ai
        </a>
        .
      </p>
    </section>
  );
}
