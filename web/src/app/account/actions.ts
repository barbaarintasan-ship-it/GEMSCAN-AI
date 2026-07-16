"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";

// Update the signed-in user's profile row. Only the fields a user is allowed to
// edit are touched — tier/status live on the subscriptions table and are only
// ever written by service-role webhooks.
export async function updateProfile(formData: FormData) {
  const displayName = String(formData.get("display_name") ?? "").trim();
  const locale = String(formData.get("locale") ?? "en");

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?redirect=/account");

  const { error } = await supabase
    .from("profiles")
    .update({
      display_name: displayName || null,
      locale: locale === "so" ? "so" : "en",
    })
    .eq("id", user.id);

  if (error) {
    redirect(`/account?error=${encodeURIComponent(error.message)}`);
  }

  revalidatePath("/account");
  redirect("/account?updated=profile");
}
