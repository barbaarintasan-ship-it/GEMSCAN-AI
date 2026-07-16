import Link from "next/link";
import { Alert } from "@/components/Alert";
import { requestPasswordReset } from "../login/actions";

export const metadata = { title: "Reset password" };

export default async function ForgotPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; sent?: string }>;
}) {
  const { error, sent } = await searchParams;

  return (
    <section className="container section" style={{ maxWidth: 420 }}>
      <h1 style={{ fontSize: "2rem" }}>Reset your password</h1>
      <p>Enter your email and we&apos;ll send you a link to set a new password.</p>

      <Alert kind="error">{error}</Alert>
      {sent ? (
        <Alert kind="success">
          If that email is registered, a reset link is on its way. Check your inbox.
        </Alert>
      ) : null}

      <form action={requestPasswordReset} className="card" style={{ marginTop: 12 }}>
        <div className="field">
          <label htmlFor="email">Email</label>
          <input className="input" id="email" name="email" type="email" required autoComplete="email" />
        </div>
        <button className="btn btn-primary btn-block" type="submit">
          Send reset link
        </button>
      </form>

      <p style={{ fontSize: 14, marginTop: 16 }}>
        Remembered it?{" "}
        <Link href="/login" className="gold">
          Back to sign in
        </Link>
      </p>
    </section>
  );
}
