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
};

// Extra profile fields collected at sign-up. Stored in the auth user's
// metadata (options.data) so they persist immediately without a schema change;
// the handle_new_user DB trigger (migration 0003) copies them into
// public.profiles so they are queryable server-side.
export type SignUpProfile = {
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
        // stores stray whitespace. Empty strings become null.
        data: {
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

  return (
    <AuthContext.Provider value={{ session, isLoading, signUp, signIn, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}
