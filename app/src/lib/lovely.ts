import { useCallback, useEffect, useState } from 'react';
import { supabase } from './supabase';
import { isTelemetryConfigured, TELEMETRY_URL, TELEMETRY_ANON_KEY } from './supabaseTelemetry';

// Lovely app users, read from the Lovely project's `public.users` via the
// `lovely-users` edge function (deployed on the Lovely project). The table is
// PII and is NOT anon-readable, so the function gates on the makelila operator's
// JWT. We pass that operator token explicitly as the Authorization header; the
// Lovely anon key rides along as the gateway `apikey`.
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
    if (!isTelemetryConfigured || !TELEMETRY_URL || !TELEMETRY_ANON_KEY) return;
    setLoading(true);
    setError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) throw new Error('Not signed in.');
      // Direct fetch rather than supabaseTelemetry.functions.invoke so the
      // function's JSON `error` body is readable on a non-2xx response —
      // invoke() consumes it and exposes only "Edge Function returned a non-2xx
      // status code". Mirrors fulfillment.ts:sendFulfillmentEmail.
      const res = await fetch(`${TELEMETRY_URL}/functions/v1/lovely-users`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: TELEMETRY_ANON_KEY,
          Authorization: `Bearer ${token}`,
        },
      });
      const bodyText = await res.text();
      if (!res.ok) {
        let detail = bodyText;
        try {
          const parsed = JSON.parse(bodyText) as { error?: string };
          if (parsed.error) detail = parsed.error;
        } catch { /* keep raw body */ }
        throw new Error(`Failed to load Lovely users (${res.status}): ${detail}`);
      }
      const parsed = JSON.parse(bodyText) as { users?: LovelyUser[] };
      setUsers(parsed.users ?? []);
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
