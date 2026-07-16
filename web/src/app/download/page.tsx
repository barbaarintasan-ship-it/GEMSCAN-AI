import Link from "next/link";
import { siteConfig } from "@/lib/config";

export const metadata = {
  title: "Download",
  description: "Get the GemScan AI app for Android and iOS.",
};

export default function DownloadPage() {
  const { androidUrl, iosUrl } = siteConfig;

  return (
    <section className="container section center" style={{ maxWidth: 620 }}>
      <div className="badge">Get the app</div>
      <h1 style={{ fontSize: "2.2rem", marginTop: 12 }}>Download GemScan AI</h1>
      <p className="muted">
        Scan gemstones, minerals, and jewelry right from your phone. Create your account here, then
        sign in on the app.
      </p>

      <div className="grid grid-2" style={{ marginTop: 28, textAlign: "left" }}>
        <div className="card">
          <h2 style={{ fontSize: "1.2rem", marginTop: 0 }}>Android</h2>
          <p className="muted">Google Play</p>
          {androidUrl ? (
            <a href={androidUrl} className="btn btn-primary btn-block">
              Get it on Android
            </a>
          ) : (
            <button className="btn btn-outline btn-block" type="button" disabled>
              Coming soon
            </button>
          )}
        </div>
        <div className="card">
          <h2 style={{ fontSize: "1.2rem", marginTop: 0 }}>iPhone &amp; iPad</h2>
          <p className="muted">App Store</p>
          {iosUrl ? (
            <a href={iosUrl} className="btn btn-primary btn-block">
              Download on iOS
            </a>
          ) : (
            <button className="btn btn-outline btn-block" type="button" disabled>
              Coming soon
            </button>
          )}
        </div>
      </div>

      <p style={{ marginTop: 24 }}>
        New here?{" "}
        <Link href="/signup" className="gold">
          Create a free account
        </Link>{" "}
        first.
      </p>
    </section>
  );
}
