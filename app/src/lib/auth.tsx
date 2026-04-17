import {
  createContext, useContext, useEffect, useMemo, useState, type ReactNode,
} from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { Navigate, useLocation } from 'react-router-dom';
import { supabase } from './supabase';

export function requireInternalDomain(email: string | undefined | null): boolean {
  if (!email) return false;
  return email.toLowerCase().endsWith('@virgohome.io');
}

type Profile = { id: string; display_name: string; role: string };

type AuthState = {
  session: Session | null;
  user: User | null;
  profile: Profile | null;
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
      alert('Access restricted to @virgohome.io accounts.');
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
    loading,
    signInWithGoogle: async () => {
      await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: window.location.origin + import.meta.env.BASE_URL,
          queryParams: { hd: 'virgohome.io' },
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
