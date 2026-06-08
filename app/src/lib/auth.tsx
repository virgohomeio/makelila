import {
  createContext, useContext, useEffect, useMemo, useState, type ReactNode,
} from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { Navigate, useLocation } from 'react-router-dom';
import { supabase } from './supabase';
import type { Role } from './permissions';

// External (non-@virgohome.io) emails permitted to sign in. Keep this set
// tiny — every entry bypasses the domain check below + needs a matching
// row in public.external_email_allowlist so handle_new_user sets
// profiles.is_internal=true on first sign-in. Adds: 2026-06-07 Ryan Yuan.
const EXTERNAL_ALLOWLIST = new Set<string>([
  'ryanyuan32@gmail.com',
]);

export function requireInternalDomain(email: string | undefined | null): boolean {
  if (!email) return false;
  const lower = email.toLowerCase();
  if (lower.endsWith('@virgohome.io')) return true;
  return EXTERNAL_ALLOWLIST.has(lower);
}

type Profile = { id: string; display_name: string; role: Role };

type AuthState = {
  session: Session | null;
  user: User | null;
  profile: Profile | null;
  /** Convenience: profile?.role (or null while loading). Pair with
   *  canDo/canView from lib/permissions.ts. */
  role: Role | null;
  loading: boolean;
  signInWithGoogle: () => Promise<void>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    const user = session?.user;
    if (!user) { setProfile(null); return; }

    if (!requireInternalDomain(user.email)) {
      supabase.auth.signOut();
      alert('Access restricted. Use your @virgohome.io account, or contact George if you need access.');
      return;
    }

    supabase
      .from('profiles')
      .select('id, display_name, role')
      .eq('id', user.id)
      .single()
      .then(({ data }) => setProfile(data as Profile | null));
  }, [session]);

  const value: AuthState = useMemo(() => ({
    session,
    user: session?.user ?? null,
    profile,
    role: profile?.role ?? null,
    loading,
    signInWithGoogle: async () => {
      // No `hd: 'virgohome.io'` pin — that would block the EXTERNAL_ALLOWLIST
      // (e.g. ryanyuan32@gmail.com) from reaching the OAuth flow at all.
      // The post-signin requireInternalDomain check still rejects every
      // address that isn't either @virgohome.io or in the allowlist.
      await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: window.location.origin + import.meta.env.BASE_URL,
        },
      });
    },
    signOut: async () => { await supabase.auth.signOut(); },
  }), [session, profile, loading]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { session, loading } = useAuth();
  const location = useLocation();
  if (loading) return <div style={{ padding: 24 }}>Loading…</div>;
  if (!session) return <Navigate to="/login" state={{ from: location }} replace />;
  return <>{children}</>;
}
