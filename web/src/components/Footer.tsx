import Link from "next/link";
import { siteConfig } from "@/lib/config";

export default function Footer() {
  return (
    <footer className="footer">
      <div className="container">
        <div className="footer-cols">
          <div>
            <div className="brand" style={{ marginBottom: 8 }}>
              GemScan<span className="gold"> AI</span>
            </div>
            <p className="muted" style={{ fontSize: 13, maxWidth: 220 }}>
              Honest AI identification for gemstones, minerals, and jewelry.
            </p>
          </div>
          <div>
            <strong style={{ fontSize: 13 }}>Product</strong>
            <Link href="/pricing">Pricing</Link>
            <Link href="/download">Download</Link>
            <Link href="/faq">FAQ</Link>
          </div>
          <div>
            <strong style={{ fontSize: 13 }}>Account</strong>
            <Link href="/login">Sign in</Link>
            <Link href="/signup">Create account</Link>
            <Link href="/account/subscription">Manage subscription</Link>
          </div>
          <div>
            <strong style={{ fontSize: 13 }}>Legal</strong>
            <Link href="/privacy">Privacy Policy</Link>
            <Link href="/terms">Terms of Service</Link>
            <a href={`mailto:${siteConfig.supportEmail}`}>Contact</a>
          </div>
        </div>
        <p className="disclaimer">
          GemScan AI does not provide certified appraisals. Results are AI-generated estimates and
          are not a substitute for a certified gemologist appraisal, insurance valuation, or lab
          report (GIA/AGS/Gübelin/SSEF). © {new Date().getFullYear()} GemScan AI.
        </p>
      </div>
    </footer>
  );
}
