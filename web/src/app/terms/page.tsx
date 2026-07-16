import { siteConfig } from "@/lib/config";

export const metadata = {
  title: "Terms of Service",
  description: "The terms that govern your use of GemScan AI.",
};

export default function TermsPage() {
  return (
    <section className="container section legal" style={{ maxWidth: 780 }}>
      <h1>Terms of Service</h1>
      <p className="muted">Last updated: 13 July 2026</p>

      <p>
        These Terms of Service (&quot;Terms&quot;) govern your use of {siteConfig.name} (the
        &quot;Service&quot;), including our website and mobile app. By creating an account or using
        the Service, you agree to these Terms.
      </p>

      <h2>1. The Service</h2>
      <p>
        {siteConfig.name} uses artificial intelligence to help identify gemstones, minerals, and
        jewelry from photos. Results are provided for educational and informational purposes only.
      </p>

      <h2>2. Not a certified appraisal</h2>
      <p>
        The Service is <strong>not</strong> a certified appraisal and is not a substitute for
        evaluation by a qualified gemologist or accredited laboratory. AI results may be incomplete
        or incorrect. You should not rely on them for insurance, resale, lending, or any legal or
        financial decision. You use identification results at your own risk.
      </p>

      <h2>3. Accounts</h2>
      <p>
        You are responsible for keeping your login credentials secure and for activity under your
        account. You must provide accurate information and be old enough to form a binding contract
        in your jurisdiction.
      </p>

      <h2>4. Subscriptions and payments</h2>
      <p>
        Paid plans are billed through the website via card or mobile money. Premium renews annually
        until canceled; Lifetime is a one-time purchase. Except where required by law, payments are
        non-refundable. Prices and features may change with notice.
      </p>

      <h2>5. Acceptable use</h2>
      <p>
        You agree not to misuse the Service, including attempting to disrupt it, reverse-engineer it,
        or use it for unlawful purposes. We may suspend accounts that violate these Terms.
      </p>

      <h2>6. Intellectual property</h2>
      <p>
        You retain rights to the photos you upload. You grant us a limited license to process those
        photos to provide the Service. All software, branding, and content of the Service remain our
        property.
      </p>

      <h2>7. Disclaimer of warranties</h2>
      <p>
        The Service is provided &quot;as is&quot; without warranties of any kind. We do not warrant
        that results will be accurate, reliable, or uninterrupted.
      </p>

      <h2>8. Limitation of liability</h2>
      <p>
        To the maximum extent permitted by law, {siteConfig.name} is not liable for any indirect,
        incidental, or consequential damages, or for any decision made in reliance on identification
        results.
      </p>

      <h2>9. Changes</h2>
      <p>
        We may update these Terms from time to time. Continued use after changes take effect
        constitutes acceptance.
      </p>

      <h2>10. Contact</h2>
      <p>
        Questions? Email{" "}
        <a className="gold" href={`mailto:${siteConfig.supportEmail}`}>
          {siteConfig.supportEmail}
        </a>
        .
      </p>
    </section>
  );
}
