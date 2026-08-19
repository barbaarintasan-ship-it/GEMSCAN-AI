// Auth context: sign up, sign in, sign out, and the current session.
// This is the full extent of what the mobile app does regarding accounts —
// no payment/purchase logic lives anywhere near this file.
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { AppState } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./supabase";
import { setCurrentIdentity } from "./currentIdentity";
import { markPhase } from "./diagnostics/jsStall";

/**
 * THE UP-TO-209-SECOND FREEZE THIS GUARDS AGAINST.
 *
 * `app/index.tsx` and `app/(app)/_layout.tsx` both gate their ENTIRE screen on
 * `isLoading`, showing only a spinner until it clears — and it used to clear
 * only when `getSession()` resolved, with no ceiling on that wait.
 * supabase-js's `getSession()` can itself wait on an internal token refresh
 * that carries no timeout of its own, and a stalled connection to the auth
 * endpoint left it unresolved for minutes at a time, MEASURED repeatedly on
 * a cold app start / session resume — exactly the moment a geologist opens
 * the app in the field. That is the one place this app is not allowed to
 * wait on a network at all: an open expedition lease already makes every
 * field screen work with no session (see expeditionLease.ts), so there was
 * never a reason for the LOADING SCREEN ITSELF to require one.
 *
 * This is a ceiling on the WAIT, not on the call — getSession() keeps running
 * underneath and still updates `session` normally if and when it resolves;
 * the app is simply never held hostage until it does.
 */
const AUTH_TIMEOUT_MS = 8_000;

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
  // Edit the signed-in user's profile fields (stored in auth user_metadata;
  // display_name is also mirrored into the profiles table).
  updateProfile: (fields: ProfileUpdate) => Promise<{ error: string | null }>;
  // Send a "forgot password" reset email.
  resetPassword: (email: string) => Promise<{ error: string | null }>;
};

export type ProfileUpdate = {
  fullName?: string;
  phone?: string;
  country?: string;
  city?: string;
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

function publishIdentity(s: Session | null): void {
  setCurrentIdentity(s?.user ? { userId: s.user.id, email: s.user.email ?? null } : null);
}

// ── Single active session (one phone per account) ───────────────────────────
// On each successful login this device writes a fresh random id to
// profiles.active_session_id and remembers it locally. When it later reads a
// DIFFERENT id — because the same account signed in on another phone — it signs
// itself out. RLS already scopes select/update to the owner (migration 0001), so
// nobody can claim or read another account's session. Failures fail OPEN: a
// network hiccup never logs a working device out, only a confirmed takeover does.
const SESSION_ID_KEY = "auth.activeSessionId";
/** How often a signed-in app re-checks that it is still the active device. */
const SESSION_CHECK_MS = 45_000;

function newSessionId(): string {
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 12);
}

async function claimActiveSession(userId: string): Promise<void> {
  try {
    const id = newSessionId();
    await AsyncStorage.setItem(SESSION_ID_KEY, id);
    await supabase.from("profiles").update({ active_session_id: id }).eq("id", userId);
  } catch {
    // A claim that could not be written just means single-session is not enforced
    // this login — never a reason to block the sign-in itself.
  }
}

/** True when the server's active session belongs to ANOTHER device. */
async function sessionWasTakenOver(userId: string): Promise<boolean> {
  try {
    const mine = await AsyncStorage.getItem(SESSION_ID_KEY);
    if (!mine) return false; // never claimed here → nothing to compare against
    const { data, error } = await supabase
      .from("profiles").select("active_session_id").eq("id", userId).maybeSingle();
    if (error || !data) return false; // unreadable → fail open, stay signed in
    const server = data.active_session_id as string | null;
    // Only a DIFFERENT non-null id is a real takeover. Null (older row, not yet
    // claimed) is not, so an existing user is never bounced on first upgrade.
    return !!server && server !== mine;
  } catch {
    return false;
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let unmounted = false;
    const doneAuthPhase = markPhase("auth.getSession");
    // See AUTH_TIMEOUT_MS above: the loading screen may not wait on the
    // network forever. getSession() is left running — a late answer still
    // lands via the .then() below, whichever fires second is a no-op.
    const timeout = setTimeout(() => {
      if (!unmounted) setIsLoading(false);
    }, AUTH_TIMEOUT_MS);

    supabase.auth.getSession().then(({ data }) => {
      doneAuthPhase();
      clearTimeout(timeout);
      if (unmounted) return;
      setSession(data.session);
      publishIdentity(data.session);
      setIsLoading(false);
    });

    const { data: subscription } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
      // Published for readers outside the context — see lib/currentIdentity.
      publishIdentity(newSession);
    });

    return () => {
      unmounted = true;
      clearTimeout(timeout);
      subscription.subscription.unsubscribe();
    };
  }, []);

  // ── Single active session enforcement ─────────────────────────────────────
  // While signed in, confirm this device still owns the account: on mount, on
  // returning to the foreground, and on a slow timer. A confirmed takeover (the
  // same account signed in elsewhere) signs this device out. Deliberately off the
  // boot-critical path — it is a plain read that fails open.
  const userId = session?.user?.id ?? null;
  useEffect(() => {
    if (!userId) return;
    let alive = true;
    const check = async () => {
      if (!alive) return;
      if (await sessionWasTakenOver(userId)) {
        await AsyncStorage.removeItem(SESSION_ID_KEY);
        await supabase.auth.signOut(); // onAuthStateChange clears session + identity
      }
    };
    void check();
    const timer = setInterval(() => void check(), SESSION_CHECK_MS);
    const sub = AppState.addEventListener("change", (s) => { if (s === "active") void check(); });
    return () => { alive = false; clearInterval(timer); sub.remove(); };
  }, [userId]);

  // B6 (perf): stable identities so the context value below only changes when
  // session/isLoading change, not on every provider render. Deps are empty
  // because these close over module-level constants (supabase, FUNCTIONS_URL).
  const signUp = useCallback(async (email: string, password: string, profile?: SignUpProfile) => {
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
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return { error: error.message };
    // Claim this account for THIS device — any phone already signed in will find
    // a different id on its next check and sign itself out.
    if (data.user) await claimActiveSession(data.user.id);
    return { error: null };
  }, []);

  const signOut = useCallback(async () => {
    await AsyncStorage.removeItem(SESSION_ID_KEY);
    await supabase.auth.signOut();
  }, []);

  // Permanently deletes the account + all data server-side (delete-account
  // Edge Function), then clears the local session. Required by App Store
  // Guideline 5.1.1(v) / Google Play.
  const deleteAccount = useCallback(async () => {
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
  }, []);

  // Update profile fields. phone/country/city live ONLY in auth user_metadata
  // (the profiles table has no such columns); display_name lives in both, so we
  // also mirror it into profiles (best-effort). updateUser merges the provided
  // keys into user_metadata and fires onAuthStateChange, refreshing the session.
  const updateProfile = useCallback(async (fields: ProfileUpdate) => {
    const data: Record<string, string | null> = {};
    if (fields.fullName !== undefined) data.display_name = fields.fullName.trim() || null;
    if (fields.phone !== undefined) data.phone = fields.phone.trim() || null;
    if (fields.country !== undefined) data.country = fields.country.trim() || null;
    if (fields.city !== undefined) data.city = fields.city.trim() || null;

    const { error } = await supabase.auth.updateUser({ data });
    if (error) return { error: error.message };

    if ("display_name" in data) {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (user) {
        await supabase.from("profiles").update({ display_name: data.display_name }).eq("id", user.id);
      }
    }
    return { error: null };
  }, []);

  // "Forgot password": emails a reset link. Where the link lands (in-app vs web)
  // is governed by the project's Auth "Site URL" / redirect settings.
  const resetPassword = useCallback(async (email: string) => {
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim());
    return { error: error?.message ?? null };
  }, []);

  const value = useMemo(
    () => ({ session, isLoading, signUp, signIn, signOut, deleteAccount, updateProfile, resetPassword }),
    [session, isLoading, signUp, signIn, signOut, deleteAccount, updateProfile, resetPassword],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}
