import { type NextRequest, NextResponse } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { createClient } from "@/utils/supabase/server";

// Single callback endpoint for every email link Supabase sends us:
//   - Sign-up confirmation and password recovery arrive as a token_hash + type
//     (verifyOtp), or
//   - PKCE / magic-link style flows arrive as a ?code (exchangeCodeForSession).
// On success we redirect to `next` (defaults to /account). On failure we bounce
// to /login with an error so the user isn't left on a blank page.
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);

  const token_hash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/account";

  const supabase = await createClient();

  if (token_hash && type) {
    const { error } = await supabase.auth.verifyOtp({ type, token_hash });
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`);
    }
  } else if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  return NextResponse.redirect(
    `${origin}/login?error=${encodeURIComponent(
      "That link is invalid or has expired. Please sign in or request a new link.",
    )}`,
  );
}
