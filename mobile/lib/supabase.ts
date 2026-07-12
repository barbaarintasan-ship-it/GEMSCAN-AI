// Supabase client for the mobile app.
//
// Payment-separation note: this client is used ONLY for auth (sign up/in/out,
// session management) and for reading the user's own `subscriptions` row via
// the verify-subscription Edge Function. It never talks to Stripe, PayPal,
// or any mobile money gateway — those integrations live exclusively in the
// website/backend (see /supabase/functions/create-checkout-session and
// /supabase/functions/stripe-webhook), and their API keys never ship in this
// app bundle.
import "react-native-url-polyfill/auto";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    "Missing EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY. " +
      "Set these in mobile/.env (see mobile/.env.example).",
  );
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});
