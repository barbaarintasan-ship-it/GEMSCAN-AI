import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import { Alert } from "@/components/Alert";
import { getPlan, type PlanId } from "@/lib/plans";
import { updateProfile } from "./actions";
import { signOut } from "../login/actions";

export const metadata = { title: "Your account" };

const UPDATED_COPY: Record<string, string> = {
  profile: "Profile updated.",
  password: "Password updated.",
};

export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; updated?: string }>;
}) {
  const { error, updated } = await searchParams;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?redirect=/account");

  // Profile + subscription are separate rows keyed by the user id. Both are
  // auto-created by a signup trigger, but read defensively in case of lag.
  const [{ data: profile }, { data: subscription }] = await Promise.all([
    supabase.from("profiles").select("display_name, email, locale").eq("id", user.id).maybeSingle(),
    supabase
      .from("subscriptions")
      .select("tier, status, current_period_end")
      .eq("user_id", user.id)
      .maybeSingle(),
  ]);

  const tier = (subscription?.tier ?? "free") as PlanId;
  const plan = getPlan(tier);

  return (
    <section className="container section" style={{ maxWidth: 720 }}>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <h1 style={{ fontSize: "2rem" }}>Your account</h1>
          <p className="muted">{profile?.email ?? user.email}</p>
        </div>
        <form action={signOut}>
          <button className="btn btn-outline" type="submit">
            Sign out
          </button>
        </form>
      </div>

      {error ? <Alert kind="error">{error}</Alert> : null}
      {updated ? <Alert kind="success">{UPDATED_COPY[updated] ?? "Saved."}</Alert> : null}

      <div className="grid grid-2" style={{ marginTop: 20 }}>
        <div className="card">
          <h2 style={{ fontSize: "1.25rem", marginTop: 0 }}>Profile</h2>
          <form action={updateProfile} className="stack">
            <div className="field">
              <label htmlFor="display_name">Display name</label>
              <input
                className="input"
                id="display_name"
                name="display_name"
                type="text"
                defaultValue={profile?.display_name ?? ""}
                placeholder="Your name"
              />
            </div>
            <div className="field">
              <label htmlFor="email">Email</label>
              <input
                className="input"
                id="email"
                type="email"
                value={profile?.email ?? user.email ?? ""}
                disabled
              />
              <span className="muted" style={{ fontSize: 12 }}>
                Contact support to change your email.
              </span>
            </div>
            <div className="field">
              <label htmlFor="locale">Language</label>
              <select
                className="input"
                id="locale"
                name="locale"
                defaultValue={profile?.locale === "so" ? "so" : "en"}
              >
                <option value="en">English</option>
                <option value="so">Somali (Af-Soomaali)</option>
              </select>
            </div>
            <button className="btn btn-primary" type="submit">
              Save profile
            </button>
          </form>
        </div>

        <div className="card card-hi">
          <h2 style={{ fontSize: "1.25rem", marginTop: 0 }}>Subscription</h2>
          <div className="badge">{plan?.name ?? "Free"}</div>
          <p className="muted" style={{ marginTop: 8 }}>
            Status: {subscription?.status ?? "active"}
          </p>
          {subscription?.current_period_end ? (
            <p className="muted" style={{ fontSize: 13 }}>
              Renews / expires{" "}
              {new Date(subscription.current_period_end).toLocaleDateString()}
            </p>
          ) : null}
          <div style={{ marginTop: 16 }}>
            <Link href="/account/subscription" className="btn btn-primary btn-block">
              Manage subscription
            </Link>
          </div>
        </div>
      </div>

      <div className="row" style={{ marginTop: 24, gap: 16 }}>
        <Link href="/update-password" className="muted">
          Change password
        </Link>
        <Link href="/download" className="muted">
          Download the app
        </Link>
      </div>
    </section>
  );
}
