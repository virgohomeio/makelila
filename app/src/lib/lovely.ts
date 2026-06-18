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

// ── Onboarding funnel ───────────────────────────────────────────────────────
// Canonical onboarding order, mirrored from the Lovely app
// (app/onboarding/page.tsx + app/api/onboarding/route.ts). 'pairing' is the
// initial DB default (just signed up); 'tour_done' = fully onboarded.
export const ONBOARDING_STEPS: { code: string; label: string }[] = [
  { code: 'pairing',          label: 'Signed up' },
  { code: 'welcome_done',     label: 'Welcome' },
  { code: 'quiz_done',        label: 'Preference quiz' },
  { code: 'customizing_done', label: 'Customizing' },
  { code: 'checklist_done',   label: 'Unboxing checklist' },
  { code: 'hardware_done',    label: 'Hardware walkthrough' },
  { code: 'pairing_done',     label: 'Paired device' },
  { code: 'tour_done',        label: 'Completed' },
];

export type FunnelRow = { code: string; label: string; count: number; pct: number };

// Counts users per onboarding_step, returned in canonical order with % of total.
// Unknown step codes are appended after the canonical ones.
export function onboardingFunnel(users: LovelyUser[]): FunnelRow[] {
  const total = users.length;
  const counts = new Map<string, number>();
  for (const u of users) {
    const k = u.onboarding_step || '(none)';
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const pct = (n: number) => (total ? Math.round((n / total) * 100) : 0);
  const rows: FunnelRow[] = ONBOARDING_STEPS.map(s => {
    const count = counts.get(s.code) ?? 0;
    counts.delete(s.code);
    return { code: s.code, label: s.label, count, pct: pct(count) };
  });
  for (const [code, count] of counts) {
    rows.push({ code, label: code, count, pct: pct(count) });
  }
  return rows;
}

// ── Approve (admin write) ───────────────────────────────────────────────────
// Calls the lovely-verify-user edge function (leadership-gated server-side).
// Resolves on success; throws with the function's error body on a non-2xx.
export async function approveLovelyUser(userId: string): Promise<void> {
  if (!isTelemetryConfigured || !TELEMETRY_URL || !TELEMETRY_ANON_KEY) {
    throw new Error('Lovely telemetry not configured.');
  }
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) throw new Error('Not signed in.');
  const res = await fetch(`${TELEMETRY_URL}/functions/v1/lovely-verify-user`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: TELEMETRY_ANON_KEY,
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ user_id: userId }),
  });
  const text = await res.text();
  if (!res.ok) {
    let detail = text;
    try {
      const parsed = JSON.parse(text) as { error?: string };
      if (parsed.error) detail = parsed.error;
    } catch { /* keep raw */ }
    throw new Error(`Approve failed (${res.status}): ${detail}`);
  }
}

// ── OTA / firmware updates (admin) ──────────────────────────────────────────
// Backed by the lovely-ota edge function (leadership-gated, service role). The
// admin view needs inactive drafts too, which the public RLS hides — so all
// reads/writes go through the function.
export type LovelyOtaUpdate = {
  id: string;
  version: string;
  description: string | null;
  release_notes: string | null;
  is_active: boolean | null;
  created_at: string | null;
  updated_at: string | null;
};

export type OtaUpsertInput = {
  id?: string;
  version: string;
  description?: string | null;
  release_notes?: string | null;
  is_active?: boolean;
};

// Shared POST to the lovely-ota function with the operator token + Lovely anon
// apikey; surfaces the function's JSON error body on a non-2xx.
async function callLovelyOta(payload: Record<string, unknown>): Promise<unknown> {
  if (!isTelemetryConfigured || !TELEMETRY_URL || !TELEMETRY_ANON_KEY) {
    throw new Error('Lovely telemetry not configured.');
  }
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) throw new Error('Not signed in.');
  const res = await fetch(`${TELEMETRY_URL}/functions/v1/lovely-ota`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: TELEMETRY_ANON_KEY,
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) {
    let detail = text;
    try {
      const parsed = JSON.parse(text) as { error?: string };
      if (parsed.error) detail = parsed.error;
    } catch { /* keep raw */ }
    throw new Error(`Lovely OTA request failed (${res.status}): ${detail}`);
  }
  try { return JSON.parse(text); } catch { return {}; }
}

export function useLovelyOta() {
  const [updates, setUpdates] = useState<LovelyOtaUpdate[]>([]);
  const [loading, setLoading] = useState<boolean>(isTelemetryConfigured);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    if (!isTelemetryConfigured) return;
    setLoading(true);
    setError(null);
    try {
      const data = await callLovelyOta({ action: 'list' });
      setUpdates(((data as { updates?: LovelyOtaUpdate[] }).updates) ?? []);
    } catch (e) {
      setError((e as Error).message);
      setUpdates([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return { updates, loading, error, refetch };
}

export async function upsertLovelyOta(input: OtaUpsertInput): Promise<LovelyOtaUpdate> {
  const data = await callLovelyOta({ action: 'upsert', ...input });
  return (data as { update: LovelyOtaUpdate }).update;
}

// The update the app currently serves = newest active one (matches the app's
// ota/check). Returns its id, or null when nothing is active.
export function liveOtaId(updates: LovelyOtaUpdate[]): string | null {
  const active = updates
    .filter(u => u.is_active)
    .sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''));
  return active[0]?.id ?? null;
}
