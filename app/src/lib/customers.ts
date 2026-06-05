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
  // Unit serials from the fulfillment sheet (source of truth). Synced by
  // public.sync_customer_serials_from_fulfillment(); see scripts/import-fulfillment-sheet.mjs.
  serials: string[] | null;
  serials_synced_at: string | null;
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

// Backlog #58 — aggregated per-customer profitability sourced from the
// public.customer_profitability SQL view (migration 20260604260000). The
// view does the heavy joining server-side so the browser doesn't have
// to pull thousands of orders/returns/tickets.
// Backlog #58 V3 — 4-bucket cost model. See migration
// 20260605010000_customer_profitability_v3.sql for the SQL view.
export type CustomerProfitability = {
  id: string;
  full_name: string;
  email: string | null;
  country: string | null;
  onboard_date: string | null;
  // Revenue
  revenue_usd: number;
  // 4 cost buckets — sale_cogs + sale_shipping are sales-only;
  // expected_warranty covers ALL non-cancelled replacement orders;
  // expected_refund covers ALL non-denied refund approvals.
  sale_cogs_usd: number;
  sale_shipping_usd: number;
  expected_warranty_cost_usd: number;
  expected_refund_usd: number;
  // Margin = revenue - all 4 buckets (no double-count)
  net_margin_usd: number;
  // Settled-refund subset (status='refunded' only) — shown alongside
  // expected so operators can see in-flight vs booked.
  settled_refund_usd: number;
  // Counts
  order_count: number;
  replacement_count: number;
  open_replacement_count: number;
  refund_count: number;
  in_flight_refund_count: number;
  ticket_count: number;
  // Leading indicator: open warranty/defect tickets with no replacement
  // order yet — expected_warranty will grow when these convert.
  open_warranty_ticket_count: number;
  is_team_member: boolean;
};

export function useCustomerProfitability(): {
  rows: CustomerProfitability[];
  loading: boolean;
  error: Error | null;
} {
  const [rows, setRows] = useState<CustomerProfitability[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error: err } = await supabase
        .from('customer_profitability')
        .select('*')
        .order('net_margin_usd', { ascending: false });
      if (cancelled) return;
      if (err) {
        setError(err as unknown as Error);
        setLoading(false);
        return;
      }
      // Supabase returns numerics as strings; coerce to numbers so the UI
      // can do arithmetic without string juggling.
      const coerced = (data ?? []).map((r: Record<string, unknown>) => ({
        ...r,
        revenue_usd:                Number(r.revenue_usd ?? 0),
        sale_cogs_usd:              Number(r.sale_cogs_usd ?? 0),
        sale_shipping_usd:          Number(r.sale_shipping_usd ?? 0),
        expected_warranty_cost_usd: Number(r.expected_warranty_cost_usd ?? 0),
        expected_refund_usd:        Number(r.expected_refund_usd ?? 0),
        settled_refund_usd:         Number(r.settled_refund_usd ?? 0),
        net_margin_usd:             Number(r.net_margin_usd ?? 0),
      })) as CustomerProfitability[];
      setRows(coerced);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  return { rows, loading, error };
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
 *  body so the UI can show a "N new, M fields filled" toast. The sync inserts
 *  net-new customers, fills blank columns on existing rows, and refreshes
 *  last_synced_at — it never overwrites operator-curated values. */
export async function syncCustomersFromHubspot(): Promise<{
  pages: number; fetched: number;
  inserted: number; filled: number; touched: number;
  upserted: number; skipped: number;
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
    pages: number; fetched: number;
    inserted: number; filled: number; touched: number;
    upserted: number; skipped: number;
  };
  await logAction('hubspot_sync', 'customers', `${json.inserted} new, ${json.filled} filled, ${json.touched} refreshed, ${json.skipped} skipped`);
  return json;
}

// ────────────────────────────────────────────────────────────────────────
// Auto follow-up queue (spec: docs/superpowers/specs/2026-06-03-auto-followup-queue-design.md)
// ────────────────────────────────────────────────────────────────────────

export type FollowupDraft = {
  customer_id: string;
  customer_name: string;
  customer_phone: string | null;
  days_overdue: number;
  fu_kind: 'fu1' | 'fu2';
  draft_message: string | null;
  skip_reason: string | null;
  context_summary: string;
};

export async function generateFollowupDrafts(customer_ids: string[]): Promise<{ drafts: FollowupDraft[] }> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error('Not signed in');
  const res = await fetch(`${SUPABASE_URL}/functions/v1/generate-followup-drafts`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({ customer_ids }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body as { drafts: FollowupDraft[] };
}

export async function sendFollowupSms(input: { customer_id: string; message: string }): Promise<{ ok: boolean; duplicate?: boolean; test_redirected?: boolean }> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error('Not signed in');
  const res = await fetch(`${SUPABASE_URL}/functions/v1/send-followup-sms`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify(input),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}
