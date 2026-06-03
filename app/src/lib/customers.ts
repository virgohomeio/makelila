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
  onboard_date: string | null;
  fu1_status: string | null;
  fu2_status: string | null;
  fu_notes: string | null;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
};

export type FuState =
  | 'overdue_fu1' | 'overdue_fu2'
  | 'due_fu1' | 'due_fu2'
  | 'upcoming_fu1' | 'upcoming_fu2'
  | 'complete' | 'unscheduled';

export const FU_STATE_META: Record<FuState, { label: string; color: string; bg: string; sortKey: number }> = {
  overdue_fu1:  { label: 'FU1 overdue',  color: '#9b2c2c', bg: '#fff5f5', sortKey: 1 },
  overdue_fu2:  { label: 'FU2 overdue',  color: '#9b2c2c', bg: '#fff5f5', sortKey: 2 },
  due_fu1:      { label: 'FU1 today',    color: '#c05621', bg: '#fffaf0', sortKey: 3 },
  due_fu2:      { label: 'FU2 today',    color: '#c05621', bg: '#fffaf0', sortKey: 4 },
  upcoming_fu1: { label: 'FU1 upcoming', color: '#2b6cb0', bg: '#ebf8ff', sortKey: 5 },
  upcoming_fu2: { label: 'FU2 upcoming', color: '#2b6cb0', bg: '#ebf8ff', sortKey: 6 },
  complete:     { label: 'Complete',     color: '#276749', bg: '#f0fff4', sortKey: 7 },
  unscheduled:  { label: '—',            color: '#718096', bg: '#f7fafc', sortKey: 8 },
};

// Days from onboard completion until each follow-up is due. Reina's "1-week,
// 1-month" framing (walkthrough #40): one check-in at a week, one at a month.
export const FU1_DAYS = 7;
export const FU2_DAYS = 30;

/** Compute the follow-up state for a customer. FU1 cadence: FU1_DAYS after
 *  onboard. FU2 cadence: FU2_DAYS after onboard. "Today" = same calendar day. */
export function computeFuState(c: Customer, today: Date = new Date()): FuState {
  if (!c.onboard_date) return 'unscheduled';
  const onboard = new Date(c.onboard_date + 'T00:00:00');
  const fu1Due = new Date(onboard); fu1Due.setDate(fu1Due.getDate() + FU1_DAYS);
  const fu2Due = new Date(onboard); fu2Due.setDate(fu2Due.getDate() + FU2_DAYS);
  const todayMid = new Date(today); todayMid.setHours(0, 0, 0, 0);

  if (c.fu1_status && c.fu2_status) return 'complete';

  if (!c.fu1_status) {
    if (todayMid > fu1Due) return 'overdue_fu1';
    if (todayMid.getTime() === fu1Due.getTime()) return 'due_fu1';
    return 'upcoming_fu1';
  }
  // fu1 done, fu2 pending
  if (todayMid > fu2Due) return 'overdue_fu2';
  if (todayMid.getTime() === fu2Due.getTime()) return 'due_fu2';
  return 'upcoming_fu2';
}

/** Mark a follow-up done (or update its recorded status). Pass `kind='fu1'`
 *  or `'fu2'`. The status string is free-form to match the calendar's
 *  values: 'called' / 'messaged' / 'reviewed' / 'completed' / etc. */
export async function recordFollowUp(
  customerId: string,
  kind: 'fu1' | 'fu2',
  status: string,
  noteToAppend?: string,
): Promise<void> {
  const col = kind === 'fu1' ? 'fu1_status' : 'fu2_status';
  const patch: Record<string, unknown> = { [col]: status };
  if (noteToAppend?.trim()) {
    // Read existing notes to append rather than overwrite
    const { data: existing } = await supabase
      .from('customers')
      .select('fu_notes')
      .eq('id', customerId)
      .single();
    const today = new Date().toISOString().slice(0, 10);
    const newLine = `[Makelila ${today}] ${kind.toUpperCase()} ${status}: ${noteToAppend.trim()}`;
    patch.fu_notes = existing?.fu_notes ? `${existing.fu_notes}\n${newLine}` : newLine;
  }
  const { error } = await supabase.from('customers').update(patch).eq('id', customerId);
  if (error) throw error;
  await logAction('followup_recorded', customerId, `${kind} = ${status}`);
}

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

/** Push a filtered customer list to a Klaviyo list. Same filter semantics as
 *  exportPurchasers. The Supabase edge function `push-customer-list` builds
 *  the same purchaser set and bulk-subscribes profiles via Klaviyo's OAuth-
 *  authenticated API.
 *
 *  Fails with a clear message if KLAVIYO_* secrets aren't set yet. */
export async function pushToKlaviyo(opts: {
  list_id: string;
  filter: 'all_purchasers' | 'minus_refunds';
}): Promise<{ pushed: number; excluded: number; message?: string }> {
  const { data: { session } } = await supabase.auth.getSession();
  const res = await fetch(`${SUPABASE_URL}/functions/v1/push-customer-list`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${session?.access_token ?? SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify(opts),
  });
  const text = await res.text();
  if (!res.ok) {
    let detail = text;
    try { detail = (JSON.parse(text) as { error?: string }).error ?? text; } catch { /* keep raw */ }
    throw new Error(`Klaviyo push failed (${res.status}): ${detail}`);
  }
  const json = JSON.parse(text) as { pushed: number; excluded: number; message?: string };
  await logAction('klaviyo_push', opts.filter, `list=${opts.list_id} pushed=${json.pushed}`);
  return json;
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
