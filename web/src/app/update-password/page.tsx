import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import { Alert } from "@/components/Alert";
import { updatePassword } from "../login/actions";

export const metadata = { title: "Set a new password" };

export default async function UpdatePasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  // Reaching this page requires an authenticated (recovery) session established
  // by /auth/confirm. If there's no session, send the user back to start over.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/forgot-password?error=Your reset link has expired. Please request a new one.");

  return (
    <section className="container section" style={{ maxWidth: 420 }}>
      <h1 style={{ fontSize: "2rem" }}>Set a new password</h1>
      <p>Choose a strong password you don&apos;t use anywhere else.</p>

      <Alert kind="error">{error}</Alert>

      <form action={updatePassword} className="card" style={{ marginTop: 12 }}>
        <div className="field">
          <label htmlFor="password">New password</label>
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
          Update password
        </button>
      </form>
    </section>
  );
}
