import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import { Alert } from "@/components/Alert";
import { signIn } from "./actions";

export const metadata = { title: "Sign in" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; redirect?: string }>;
}) {
  const { error, redirect: redirectTo } = await searchParams;

  // Already signed in? Skip the form.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user) redirect(redirectTo || "/account");

  return (
    <section className="container section" style={{ maxWidth: 420 }}>
      <h1 style={{ fontSize: "2rem" }}>Welcome back</h1>
      <p>Sign in to manage your subscription and profile.</p>

      <Alert kind="error">{error}</Alert>

      <form action={signIn} className="card" style={{ marginTop: 12 }}>
        <input type="hidden" name="redirect" value={redirectTo || "/account"} />
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
            autoComplete="current-password"
          />
        </div>
        <button className="btn btn-primary btn-block" type="submit">
          Sign in
        </button>
      </form>

      <div className="row" style={{ justifyContent: "space-between", marginTop: 16 }}>
        <Link href="/forgot-password" className="muted" style={{ fontSize: 14 }}>
          Forgot password?
        </Link>
        <Link href="/signup" style={{ fontSize: 14 }}>
          Create an account
        </Link>
      </div>
    </section>
  );
}
