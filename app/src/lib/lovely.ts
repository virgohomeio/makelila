import { useCallback, useEffect, useState } from 'react';
import { supabase } from './supabase';
import { supabaseTelemetry, isTelemetryConfigured } from './supabaseTelemetry';

// Lovely app users, read from the Lovely project's `public.users` via the
// `lovely-users` edge function (deployed on the Lovely project). The table is
// PII and is NOT anon-readable, so the function gates on the makelila operator's
// JWT. We pass that operator token explicitly as the Authorization header; the
// telemetry client supplies the Lovely anon `apikey` automatically.
export type LovelyUser = {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  serial_number: string | null;
  onboarding_step: string | null;
  is_verified: boolean | null;
  verified_at: string | null;
  mailing_list: boolean | null;
  last_login_at: string | null;
  login_count: number | null;
  created_at: string | null;
  updated_at: string | null;
};

export function useLovelyUsers() {
  const [users, setUsers] = useState<LovelyUser[]>([]);
  const [loading, setLoading] = useState<boolean>(isTelemetryConfigured);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    if (!isTelemetryConfigured || !supabaseTelemetry) return;
    setLoading(true);
    setError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) throw new Error('Not signed in.');
      const { data, error: invokeErr } = await supabaseTelemetry.functions.invoke(
        'lovely-users',
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (invokeErr) throw invokeErr;
      setUsers(((data as { users?: LovelyUser[] } | null)?.users) ?? []);
    } catch (e) {
      setError((e as Error).message);
      setUsers([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return { users, loading, error, configured: isTelemetryConfigured, refetch };
}
