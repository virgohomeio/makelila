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

/** Build a CSV export of customers who have ever purchased (have any row in
 *  orders or units). Optionally exclude anyone who has a refunded return
 *  (`minusRefunds=true`). CSV header is Klaviyo-friendly (email, first_name,
 *  last_name, phone + address fields + onboard_date). */
export async function exportPurchasers(opts: { minusRefunds: boolean }): Promise<{
  csv: string;
  count: number;
  excluded: number;
}> {
  // 1. Set of customer emails (lowercased) who have purchased
  const [{ data: orderEmails }, { data: unitNames }] = await Promise.all([
    supabase.from('orders').select('customer_email').not('customer_email', 'is', null),
    supabase.from('units').select('customer_name').eq('status', 'shipped'),
  ]);
  const purchaserEmails = new Set<string>();
  const purchaserNames = new Set<string>();
  for (const r of (orderEmails ?? []) as { customer_email: string | null }[]) {
    if (r.customer_email) purchaserEmails.add(r.customer_email.toLowerCase().trim());
  }
  for (const r of (unitNames ?? []) as { customer_name: string | null }[]) {
    if (r.customer_name) purchaserNames.add(r.customer_name.toLowerCase().trim());
  }

  // 2. Set of refunded customer emails + names (if filtering)
  const refundedEmails = new Set<string>();
  const refundedNames  = new Set<string>();
  if (opts.minusRefunds) {
    const { data: refunds } = await supabase
      .from('refund_approvals')
      .select('return_id, status, returns(customer_email, customer_name)')
      .eq('status', 'refunded');
    // Supabase typings model the FK join as an array even for to-one relations.
    const arr = (refunds ?? []) as Array<{
      returns: Array<{ customer_email: string | null; customer_name: string | null }> | { customer_email: string | null; customer_name: string | null } | null;
    }>;
    for (const r of arr) {
      const rets = Array.isArray(r.returns) ? r.returns : r.returns ? [r.returns] : [];
      for (const ret of rets) {
        if (ret.customer_email) refundedEmails.add(ret.customer_email.toLowerCase().trim());
        if (ret.customer_name)  refundedNames.add(ret.customer_name.toLowerCase().trim());
      }
    }
  }

  // 3. Pull all customers, filter
  const { data: customers, error } = await supabase
    .from('customers')
    .select('email, first_name, last_name, full_name, phone, address_line, city, region, postal_code, country, onboard_date')
    .order('full_name', { ascending: true });
  if (error) throw new Error(`Customer load failed: ${error.message}`);

  let excluded = 0;
  const rows: Array<typeof customers extends (infer T)[] ? T : never> = [];
  for (const c of (customers ?? [])) {
    const emailKey = c.email?.toLowerCase().trim();
    const nameKey  = c.full_name?.toLowerCase().trim();
    const isPurchaser =
      (emailKey && purchaserEmails.has(emailKey)) ||
      (nameKey  && purchaserNames.has(nameKey));
    if (!isPurchaser) continue;
    if (opts.minusRefunds) {
      const refunded =
        (emailKey && refundedEmails.has(emailKey)) ||
        (nameKey  && refundedNames.has(nameKey));
      if (refunded) { excluded++; continue; }
    }
    rows.push(c);
  }

  // 4. CSV
  const header = ['email','first_name','last_name','phone','address_line','city','region','postal_code','country','onboard_date'];
  const esc = (v: string | null | undefined): string => {
    if (v == null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push([
      esc(r.email), esc(r.first_name), esc(r.last_name), esc(r.phone),
      esc(r.address_line), esc(r.city), esc(r.region), esc(r.postal_code), esc(r.country),
      esc(r.onboard_date),
    ].join(','));
  }
  const csv = lines.join('\n');
  await logAction('customer_export', opts.minusRefunds ? 'minus_refunds' : 'all_purchasers', `${rows.length} rows`);
  return { csv, count: rows.length, excluded };
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
