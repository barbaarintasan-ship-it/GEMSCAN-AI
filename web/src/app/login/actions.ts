"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import { siteConfig } from "@/lib/config";

// Sign in with email + password. On success, bounce to the requested page (or
// the account dashboard). Errors are surfaced back through the query string so
// the (server-rendered) form can show them.
export async function signIn(formData: FormData) {
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  const redirectTo = String(formData.get("redirect") ?? "/account");

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    redirect(`/login?error=${encodeURIComponent(error.message)}`);
  }
  redirect(redirectTo);
}

// Create an account. Supabase sends a confirmation email; the link points at
// /auth/confirm which verifies the token and lands the user in their account.
export async function signUp(formData: FormData) {
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");

  const supabase = await createClient();
  const { error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      emailRedirectTo: `${siteConfig.url}/auth/confirm`,
    },
  });

  if (error) {
    redirect(`/signup?error=${encodeURIComponent(error.message)}`);
  }
  redirect("/verify-email");
}

// Send a password-reset email. The link lands on /auth/confirm with
// type=recovery, which then routes the user to /update-password.
export async function requestPasswordReset(formData: FormData) {
  const email = String(formData.get("email") ?? "");

  const supabase = await createClient();
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${siteConfig.url}/auth/confirm?next=/update-password`,
  });

  if (error) {
    redirect(`/forgot-password?error=${encodeURIComponent(error.message)}`);
  }
  redirect("/forgot-password?sent=1");
}

// Set a new password for the currently-authenticated (via recovery link) user.
export async function updatePassword(formData: FormData) {
  const password = String(formData.get("password") ?? "");

  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({ password });

  if (error) {
    redirect(`/update-password?error=${encodeURIComponent(error.message)}`);
  }
  redirect("/account?updated=password");
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/");
}
