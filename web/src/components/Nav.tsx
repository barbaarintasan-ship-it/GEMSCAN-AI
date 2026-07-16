// Top navigation. Server component: reads the auth state so the CTA reflects
// whether the visitor is signed in, without a client round-trip.
import Link from "next/link";
import { createClient } from "@/utils/supabase/server";

export default async function Nav() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return (
    <nav className="nav">
      <div className="container nav-inner">
        <Link href="/" className="brand">
          GemScan<span className="gold"> AI</span>
        </Link>
        <div className="nav-links">
          <Link href="/pricing" className="hide-sm">
            Pricing
          </Link>
          <Link href="/faq" className="hide-sm">
            FAQ
          </Link>
          <Link href="/download" className="hide-sm">
            Download
          </Link>
          {user ? (
            <Link href="/account" className="btn btn-primary" style={{ padding: "8px 18px" }}>
              Account
            </Link>
          ) : (
            <Link href="/login" className="btn btn-primary" style={{ padding: "8px 18px" }}>
              Sign in
            </Link>
          )}
        </div>
      </div>
    </nav>
  );
}
