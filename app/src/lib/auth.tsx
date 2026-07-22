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
// profiles.is_internal=true on first sign-in. Adds: 2026-06-07 Ryan Yuan,
// 2026-06-10 John (john@lila.vip, Microsoft 365).
const EXTERNAL_ALLOWLIST = new Set<string>([
  'ryanyuan32@gmail.com',
  'john@lila.vip',
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
  signInWithMicrosoft: () => Promise<void>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;

    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      setSession(data.session);
      setLoading(false);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      if (!active) return;
      if (s) { setSession(s); return; }

      // A null session arrived (e.g. SIGNED_OUT from a transient silent-refresh
      // failure, or a late null INITIAL_SESSION racing getSession() above).
      // Trusting it blindly boots a still-authenticated operator to /login —
      // the "keeps logging me out" bug. Re-read the persisted session and only
      // clear if Supabase confirms there genuinely is none. A real sign-out
      // clears storage, so getSession() returns null there and we still log out.
      //
      // Deferred out of the callback: calling supabase.auth methods *inside*
      // onAuthStateChange can deadlock the client's internal lock.
      setTimeout(() => {
        supabase.auth.getSession().then(({ data }) => {
          if (active) setSession(data.session);
        });
      }, 0);
    });

    return () => { active = false; sub.subscription.unsubscribe(); };
  }, []);

  useEffect(() => {
    const user = session?.user;
    if (!user) { setProfile(null); return; }

    // Enforce the domain ONLY on a positively-known foreign email. A session
    // can be re-emitted (token refresh, realtime re-auth after opening the
    // Customers detail panel, etc.) with user.email transiently undefined —
    // that means "session shape not fully populated yet", NOT "unauthorized".
    // Calling the destructive global signOut() on a falsy email is what booted
    // valid operators to /login (e.g. right after closing a customer profile).
    // Missing email → wait for a complete session instead of destroying it.
    if (!user.email) return;

    if (!requireInternalDomain(user.email)) {
      console.warn('[auth] domain check rejected email, signing out:', user.email);
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
    signInWithMicrosoft: async () => {
      await supabase.auth.signInWithOAuth({
        provider: 'azure',
        options: {
          redirectTo: window.location.origin + import.meta.env.BASE_URL,
          scopes: 'email openid profile',
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
