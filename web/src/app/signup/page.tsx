import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import { Alert } from "@/components/Alert";
import { signUp } from "../login/actions";

export const metadata = { title: "Create account" };

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user) redirect("/account");

  return (
    <section className="container section" style={{ maxWidth: 420 }}>
      <h1 style={{ fontSize: "2rem" }}>Create your account</h1>
      <p>Free to start — 5 scans a day, no card required.</p>

      <Alert kind="error">{error}</Alert>

      <form action={signUp} className="card" style={{ marginTop: 12 }}>
        <div className="field">
          <label htmlFor="email">Email</label>
          <input className="input" id="email" name="email" type="email" required autoComplete="email" />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            className="input"
            id="password"
            name="password"
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
          />
          <span className="muted" style={{ fontSize: 12 }}>
            At least 8 characters.
          </span>
        </div>
        <button className="btn btn-primary btn-block" type="submit">
          Create account
        </button>
      </form>

      <p className="muted" style={{ fontSize: 13, marginTop: 14 }}>
        By creating an account you agree to our <Link href="/terms" className="gold">Terms</Link> and{" "}
        <Link href="/privacy" className="gold">Privacy Policy</Link>.
      </p>
      <p style={{ fontSize: 14 }}>
        Already have an account?{" "}
        <Link href="/login" className="gold">
          Sign in
        </Link>
      </p>
    </section>
  );
}
