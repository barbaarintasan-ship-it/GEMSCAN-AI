import Link from "next/link";

export const metadata = { title: "Verify your email" };

export default function VerifyEmailPage() {
  return (
    <section className="container section center" style={{ maxWidth: 480 }}>
      <div className="badge">Check your inbox</div>
      <h1 style={{ fontSize: "2rem", marginTop: 16 }}>Verify your email</h1>
      <p>
        We&apos;ve sent you a confirmation link. Click it to activate your account, then you can
        sign in and manage your subscription.
      </p>
      <p className="muted" style={{ fontSize: 13 }}>
        Didn&apos;t get it? Check spam, or try signing in — we&apos;ll offer to resend.
      </p>
      <div style={{ marginTop: 20 }}>
        <Link href="/login" className="btn btn-primary">
          Go to sign in
        </Link>
      </div>
    </section>
  );
}
