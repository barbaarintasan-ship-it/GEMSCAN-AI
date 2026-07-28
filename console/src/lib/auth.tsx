// Auth context: Supabase session + the signed-in user's reviewer role/capabilities.
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./supabase";

const OWNER_EMAIL = "awmusse.musse@gmail.com";
const REVIEW_ROLES = ["geologist", "senior_geologist", "chief_geologist", "admin"];
const VERIFY_ROLES = ["senior_geologist", "chief_geologist", "admin"];

type AuthState = {
  session: Session | null;
  loading: boolean;
  role: string | null;       // field_contributor role, or null
  isOwner: boolean;
  canReview: boolean;
  canVerify: boolean;
  signIn: (email: string, password: string) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
};

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [role, setRole] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const loadRole = useCallback(async (s: Session | null) => {
    if (!s) { setRole(null); return; }
    const { data } = await supabase.schema("enterprise").from("field_contributor")
      .select("role").eq("user_id", s.user.id).maybeSingle();
    setRole((data?.role as string | undefined) ?? null);
  }, []);

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data }) => {
      setSession(data.session);
      await loadRole(data.session);
      setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange(async (_e, s) => {
      setSession(s);
      await loadRole(s);
    });
    return () => sub.subscription.unsubscribe();
  }, [loadRole]);

  const email = session?.user?.email?.toLowerCase() ?? "";
  const isOwner = email === OWNER_EMAIL;
  const canReview = isOwner || (role != null && REVIEW_ROLES.includes(role));
  const canVerify = isOwner || (role != null && VERIFY_ROLES.includes(role));

  const signIn = useCallback(async (e: string, p: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email: e, password: p });
    return { error: error?.message ?? null };
  }, []);
  const signOut = useCallback(async () => { await supabase.auth.signOut(); }, []);

  return (
    <Ctx.Provider value={{ session, loading, role, isOwner, canReview, canVerify, signIn, signOut }}>
      {children}
    </Ctx.Provider>
  );
}

export function useAuth(): AuthState {
  const c = useContext(Ctx);
  if (!c) throw new Error("useAuth must be used within AuthProvider");
  return c;
}
