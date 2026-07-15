// Auth context: sign up, sign in, sign out, and the current session.
// This is the full extent of what the mobile app does regarding accounts —
// no payment/purchase logic lives anywhere near this file.
import React, { createContext, useContext, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./supabase";

type AuthContextValue = {
  session: Session | null;
  isLoading: boolean;
  signUp: (
    email: string,
    password: string,
    profile?: SignUpProfile,
  ) => Promise<{ error: string | null; needsEmailConfirmation: boolean }>;
  signIn: (email: string, password: string) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
  deleteAccount: () => Promise<{ error: string | null }>;
};

const FUNCTIONS_URL = process.env.EXPO_PUBLIC_SUPABASE_FUNCTIONS_URL;

// Extra profile fields collected at sign-up. Stored in the auth user's
// metadata (options.data) so they persist immediately without a schema change;
// the handle_new_user DB trigger (migration 0003) copies them into
// public.profiles so they are queryable server-side.
export type SignUpProfile = {
  fullName?: string;
  phone?: string;
  country?: string;
  city?: string;
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setIsLoading(false);
    });

    const { data: subscription } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
    });

    return () => subscription.subscription.unsubscribe();
  }, []);

  const signUp = async (email: string, password: string, profile?: SignUpProfile) => {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        // Trimmed here so downstream (metadata + the profiles trigger) never
        // stores stray whitespace. Empty strings become null. display_name is
        // the member's full name, shown as the greeting on the home screen.
        data: {
          display_name: profile?.fullName?.trim() || null,
          phone: profile?.phone?.trim() || null,
          country: profile?.country?.trim() || null,
          city: profile?.city?.trim() || null,
        },
      },
    });
    if (error) return { error: error.message, needsEmailConfirmation: false };
    // When the project requires email confirmation, signUp succeeds but returns
    // no session — the user must confirm via email before they can log in. When
    // confirmation is off, a session is returned immediately and onAuthStateChange
    // will pick it up. Distinguish the two so the UI can react correctly instead
    // of silently bouncing back to the login screen.
    return { error: null, needsEmailConfirmation: data.session === null };
  };

  const signIn = async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    return { error: error?.message ?? null };
  };

  const signOut = async () => {
    await supabase.auth.signOut();
  };

  // Permanently deletes the account + all data server-side (delete-account
  // Edge Function), then clears the local session. Required by App Store
  // Guideline 5.1.1(v) / Google Play.
  const deleteAccount = async () => {
    const {
      data: { session: current },
    } = await supabase.auth.getSession();
    if (!current) return { error: "You are not signed in." };
    if (!FUNCTIONS_URL) return { error: "Account deletion is not available right now." };
    try {
      const res = await fetch(`${FUNCTIONS_URL}/delete-account`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${current.access_token}`,
          "Content-Type": "application/json",
        },
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.success) {
        return { error: body?.error ?? "Could not delete your account. Please try again." };
      }
      await supabase.auth.signOut();
      return { error: null };
    } catch (err) {
      return { error: (err as Error).message };
    }
  };

  return (
    <AuthContext.Provider value={{ session, isLoading, signUp, signIn, signOut, deleteAccount }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}
