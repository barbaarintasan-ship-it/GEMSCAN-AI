import { siteConfig } from "@/lib/config";

export const metadata = {
  title: "Privacy Policy",
  description: "How GemScan AI collects, uses, and protects your data.",
};

export default function PrivacyPage() {
  return (
    <section className="container section legal" style={{ maxWidth: 780 }}>
      <h1>Privacy Policy</h1>
      <p className="muted">Last updated: 13 July 2026</p>

      <p>
        This Privacy Policy explains how {siteConfig.name} (&quot;we&quot;, &quot;us&quot;) collects,
        uses, and protects your information when you use our website and mobile app. By using
        {" "}
        {siteConfig.name}, you agree to this policy.
      </p>

      <h2>Information we collect</h2>
      <ul>
        <li>
          <strong>Account information:</strong> your email address, optional display name, and
          language preference.
        </li>
        <li>
          <strong>Scan content:</strong> photos you submit for identification and the resulting AI
          assessments, kept as your scan history.
        </li>
        <li>
          <strong>Subscription &amp; payment records:</strong> your plan, status, and a reference to
          the payment. Card and mobile-money details are handled by our payment providers — we do
          not store full payment credentials.
        </li>
        <li>
          <strong>Technical data:</strong> basic device and log information used to keep the service
          secure and reliable.
        </li>
      </ul>

      <h2>How we use your information</h2>
      <ul>
        <li>To provide identification results and maintain your scan history.</li>
        <li>To manage your account, subscription, and payments.</li>
        <li>To secure the service and prevent abuse.</li>
        <li>To respond to support requests.</li>
      </ul>

      <h2>Sharing</h2>
      <p>
        We share data only with service providers who help us run the service (for example, our
        cloud backend, AI model providers for processing your scans, and payment processors), and
        only as needed. We do not sell your personal information.
      </p>

      <h2>Data retention</h2>
      <p>
        We keep your account and scan data while your account is active. You can request deletion of
        your account and associated data by contacting us.
      </p>

      <h2>Your choices</h2>
      <p>
        You can edit your profile, change your password, and manage your subscription from your
        account. To delete your account or request a copy of your data, email us.
      </p>

      <h2>Contact</h2>
      <p>
        Questions about privacy? Email{" "}
        <a className="gold" href={`mailto:${siteConfig.supportEmail}`}>
          {siteConfig.supportEmail}
        </a>
        .
      </p>
    </section>
  );
}
