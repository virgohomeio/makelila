import { useEffect, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase';
import { logAction } from './activityLog';

export type Customer = {
  id: string;
  hubspot_id: string | null;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  full_name: string;
  phone: string | null;
  address_line: string | null;
  city: string | null;
  region: string | null;
  postal_code: string | null;
  country: string | null;
  notes: string | null;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
};

export function useCustomers(): { customers: Customer[]; loading: boolean } {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let channel: RealtimeChannel | null = null;
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from('customers')
        .select('*')
        .order('full_name', { ascending: true });
      if (cancelled) return;
      if (!error && data) setCustomers(data as Customer[]);
      setLoading(false);

      channel = supabase
        .channel('customers:realtime')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'customers' }, (payload) => {
          setCustomers(prev => {
            if (payload.eventType === 'DELETE' && payload.old) {
              return prev.filter(c => c.id !== (payload.old as { id: string }).id);
            }
            if (payload.new) {
              const row = payload.new as Customer;
              const idx = prev.findIndex(c => c.id === row.id);
              if (idx >= 0) { const next = [...prev]; next[idx] = row; return next; }
              return [...prev, row].sort((a, b) => a.full_name.localeCompare(b.full_name));
            }
            return prev;
          });
        })
        .subscribe();
    })();
    return () => { cancelled = true; if (channel) void channel.unsubscribe(); };
  }, []);

  return { customers, loading };
}

/** Trigger the sync-hubspot-customers edge function. Returns the response
 *  body so the UI can show a "synced N, skipped M" toast. */
export async function syncCustomersFromHubspot(): Promise<{
  pages: number; fetched: number; upserted: number; skipped: number;
}> {
  const { data: { session } } = await supabase.auth.getSession();
  const res = await fetch(`${SUPABASE_URL}/functions/v1/sync-hubspot-customers`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${session?.access_token ?? SUPABASE_ANON_KEY}`,
    },
    body: '{}',
  });
  const text = await res.text();
  if (!res.ok) {
    let detail = text;
    try { detail = (JSON.parse(text) as { error?: string }).error ?? text; } catch { /* keep raw */ }
    throw new Error(`HubSpot sync failed (${res.status}): ${detail}`);
  }
  const json = JSON.parse(text) as {
    pages: number; fetched: number; upserted: number; skipped: number;
  };
  await logAction('hubspot_sync', 'customers', `${json.upserted} upserted, ${json.skipped} skipped`);
  return json;
}
