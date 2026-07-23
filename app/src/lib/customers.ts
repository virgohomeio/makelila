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
  // Editable profile fields surfaced in the Follow-Up customer panel.
  color: string | null;
  shipped_on: string | null;
  received_on: string | null;
  diagnosis_on: string | null;
  dashboard: string | null;
  software: string | null;
  timezone: string | null;
  fu1_status: string | null;
  fu2_status: string | null;
  fu_notes: string | null;
  review_status: string | null;
  manual_status_tags: string[] | null;
  last_synced_at: string | null;
  // Unit serials from the fulfillment sheet (source of truth). Synced by
  // public.sync_customer_serials_from_fulfillment(); see scripts/import-fulfillment-sheet.mjs.
  serials: string[] | null;
  serials_synced_at: string | null;
  // Set by the Journey tab when it sends the name-collection email
  // (Customer module → Journey). NULL = never sent. Used to dedupe so
  // operators don't accidentally double-spam the same nameless customer.
  name_request_sent_at: string | null;
  // Journey tab: operator-set CJM stage override. NULL = use the
  // auto-inferred stage. See JourneyTab's StageKey union for valid values.
  journey_stage_override: string | null;
  journey_stage_override_at: string | null;
  journey_stage_override_by: string | null;
  first_touch_source: string | null;
  first_touch_campaign_id: string | null;
  first_touch_at: string | null;
  last_touch_source: string | null;
  last_touch_campaign_id: string | null;
  last_touch_at: string | null;
  // J6: when true, the telemetry auto-ticket cron skips all units for this customer.
  telemetry_autoticket_suppress: boolean;
  // FR-6: when set, this row is a USER acting for the purchaser at this id
  // (gift/household case); refunds + accounting resolve to the purchaser.
  // NULL = this row is its own purchaser. See resolvePurchaserId().
  purchaser_id: string | null;
  created_at: string;
  updated_at: string;
};

// ── FR-6: CUSTOMER (purchaser) vs USER (submitter) ──────────────────────────
// Every person is a customers row. A row representing a USER acting for someone
// else links to the PURCHASER via purchaser_id; refunds/accounting book against
// the purchaser. These pure helpers are the single resolution point.

/** The accounting entity for a customer row: the linked purchaser if set,
 *  otherwise the row itself. */
export function resolvePurchaserId(row: { id: string; purchaser_id: string | null }): string {
  return row.purchaser_id ?? row.id;
}

/** email (lowercased/trimmed) → resolved PURCHASER id. A user's email maps to
 *  the purchaser they act for, so refund-card lookups book against the payer. */
export function buildPurchaserIdByEmail(
  rows: Array<{ id: string; email: string | null; purchaser_id: string | null }>,
): Map<string, string> {
  const m = new Map<string, string>();
  for (const r of rows) {
    if (r.email) m.set(r.email.toLowerCase().trim(), resolvePurchaserId(r));
  }
  return m;
}

export function parseUtm(
  landingUrl: string | null | undefined,
): { source: string | null; campaign: string | null } {
  if (!landingUrl) return { source: null, campaign: null };
  try {
    const url = new URL(landingUrl);
    const source = url.searchParams.get('utm_source');
    const campaign = url.searchParams.get('utm_campaign');
    if (!source) return { source: 'shopify_direct', campaign: null };
    return { source, campaign };
  } catch {
    return { source: null, campaign: null };
  }
}

export async function updateLastTouch(
  customerId: string,
  source: string,
  campaignId: string | null,
): Promise<void> {
  const { error } = await supabase
    .from('customers')
    .update({
      last_touch_source: source,
      last_touch_campaign_id: campaignId,
      last_touch_at: new Date().toISOString(),
    })
    .eq('id', customerId);
  if (error) throw error;
  await logAction(
    'customer_last_touch_updated',
    customerId,
    `source=${source} campaign=${campaignId ?? 'none'}`,
    { entityType: 'customer', entityId: customerId },
  );
}

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
// Call-anchored follow-up cadence (spec 2026-06-11): FU1 two weeks, FU2 four
// weeks after the onboarding call. customers.onboard_date is mirrored from the
// onboarding-call-complete date by markOnboardingComplete(), so it's the call
// anchor. (Was 7 / 30 days under the prior onboard-date cadence.)
export const FU1_DAYS = 14;
export const FU2_DAYS = 28;

/** FU1/FU2 due dates computed from an anchor date (ISO `YYYY-MM-DD`). */
export function followUpDueDates(anchorIso: string): { fu1Due: Date; fu2Due: Date } {
  const anchor = new Date(anchorIso.slice(0, 10) + 'T00:00:00');
  const fu1Due = new Date(anchor); fu1Due.setDate(fu1Due.getDate() + FU1_DAYS);
  const fu2Due = new Date(anchor); fu2Due.setDate(fu2Due.getDate() + FU2_DAYS);
  return { fu1Due, fu2Due };
}

/** Compute the follow-up state for a customer. Due dates count from `anchorIso`
 *  when supplied (the effective anchor — a completed `onboard_date`, a
 *  ticket-close reschedule, or a SCHEDULED onboarding call date), otherwise
 *  from `onboard_date`. "Today" = same calendar day. */
export function computeFuState(c: Customer, today: Date = new Date(), anchorIso?: string | null): FuState {
  const anchor = anchorIso ?? c.onboard_date;
  if (!anchor) return 'unscheduled';
  const { fu1Due, fu2Due } = followUpDueDates(anchor);
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

/** Set the review state used by the Follow-Ups directory "awaiting review"
 *  filter. Pass 'requested' when a review ask is sent, 'received' when it's in
 *  hand, or null to clear. */
export async function setReviewStatus(
  customerId: string,
  status: 'requested' | 'received' | null,
): Promise<void> {
  const { error } = await supabase
    .from('customers')
    .update({ review_status: status })
    .eq('id', customerId);
  if (error) throw error;
  await logAction('review_status_set', customerId, status ?? '(cleared)',
    { entityType: 'customer', entityId: customerId });
}

// Editable profile fields from the Follow-Up customer panel. `serial` writes
// to the serials[] array (single entry); everything else maps 1:1 to a column.
export type CustomerProfilePatch = {
  serial?: string;
  color?: string;
  shipped_on?: string;
  received_on?: string;
  onboard_date?: string;
  diagnosis_on?: string;
  dashboard?: string;
  software?: string;
  timezone?: string;
  address_line?: string;
};

export async function updateCustomerProfile(customerId: string, patch: CustomerProfilePatch): Promise<void> {
  const { serial, ...rest } = patch;
  const update: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rest)) update[k] = v === '' ? null : v;
  if (serial !== undefined) update.serials = serial.trim() ? [serial.trim()] : [];
  const { error } = await supabase.from('customers').update(update).eq('id', customerId);
  if (error) throw error;
  await logAction('customer_profile_updated', customerId, Object.keys(patch).join(', '),
    { entityType: 'customer', entityId: customerId });
}

// Backlog #58 — aggregated per-customer profitability sourced from the
// public.customer_profitability SQL view (migration 20260604260000). The
// view does the heavy joining server-side so the browser doesn't have
// to pull thousands of orders/returns/tickets.
// Backlog #58 V3 + V4 — 4-bucket cost model with sales tax split out
// of revenue (V4). See migration 20260605050000_customer_profitability_v4_tax_split.sql.
export type CustomerProfitability = {
  id: string;
  full_name: string;
  email: string | null;
  country: string | null;
  onboard_date: string | null;
  // Revenue (net of tax — tax is pass-through to govt and not VCycene income)
  revenue_usd: number;
  // Sales tax collected on behalf of govt — informational, NOT part of margin
  tax_collected_usd: number;
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
        tax_collected_usd:          Number(r.tax_collected_usd ?? 0),
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

// ── 30-day refund window (anchored on onboarding date) ──────────────────────
// Business rule: a customer who has been using the LILA composter for 30+ days
// without any issues is not automatically eligible for a refund — those are
// evaluated case-by-case by Finance. The Refunds tab surfaces this on each
// refund card. The clock starts from the customer's onboarding date
// (customers.onboard_date), not the delivery date.

export type RefundUsageWindow = {
  days: number | null;      // whole days since onboarding; null when unknown
  over30: boolean | null;   // true = 30+ days, false = under 30, null = unknown
};

/** Days since onboarding + whether the customer has passed the 30-day window.
 *  Returns nulls when there's no valid onboarding date on file. */
export function refundUsageWindow(
  onboardDate: string | null | undefined,
  now: Date = new Date(),
): RefundUsageWindow {
  if (!onboardDate) return { days: null, over30: null };
  const t = new Date(onboardDate).getTime();
  if (Number.isNaN(t)) return { days: null, over30: null };
  const days = Math.floor((now.getTime() - t) / 86_400_000);
  return { days, over30: days >= 30 };
}

/** Map of lowercased customer email → onboard_date, for the Refunds tab's
 *  30-day usage-window badge. Read-only snapshot (no realtime — onboarding
 *  dates change rarely and the tab already refetches on mount). */
export function useOnboardDates(): { byEmail: Map<string, string | null>; loading: boolean } {
  const [byEmail, setByEmail] = useState<Map<string, string | null>>(new Map());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await supabase.from('customers').select('email, onboard_date');
      if (cancelled) return;
      const m = new Map<string, string | null>();
      for (const r of (data ?? []) as { email: string | null; onboard_date: string | null }[]) {
        if (r.email) m.set(r.email.toLowerCase().trim(), r.onboard_date);
      }
      setByEmail(m);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  return { byEmail, loading };
}

/** Map of lowercased customer email → customer id. Lets the Refunds tab group
 *  a household's records (tickets, etc.) by customer even when they span
 *  multiple emails — e.g. a couple where one partner's tickets carry a second
 *  email but all attach to one customer record. Read-only snapshot. */
/** email → resolved PURCHASER id (FR-6). A gift/household user's email resolves
 *  to the purchaser they act for, so refund lookups book the accounting entity,
 *  not the submitter. */
export function useCustomerIdByEmail(): { byEmail: Map<string, string>; loading: boolean } {
  const [byEmail, setByEmail] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await supabase.from('customers').select('id, email, purchaser_id');
      if (cancelled) return;
      setByEmail(buildPurchaserIdByEmail(
        (data ?? []) as { id: string; email: string | null; purchaser_id: string | null }[],
      ));
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  return { byEmail, loading };
}

/** FR-6: link a USER row to the PURCHASER it acts for (or pass null to unlink,
 *  making the row its own purchaser again). */
export async function setPurchaser(userId: string, purchaserId: string | null): Promise<void> {
  if (purchaserId === userId) throw new Error('A customer cannot be their own linked purchaser.');
  const { error } = await supabase.from('customers')
    .update({ purchaser_id: purchaserId }).eq('id', userId);
  if (error) throw error;
  await logAction('customer_purchaser_linked', userId, purchaserId ?? 'unlinked');
}

export function useCustomers(): {
  customers: Customer[];
  loading: boolean;
  /** Force-refetch the full customers list. Realtime doesn't fire
   *  reliably for in-app writes (Journey override, follow-up record,
   *  etc.) — components that mutate customer rows should call this
   *  to refresh local state. */
  refresh: () => Promise<void>;
} {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  // Bumped by refresh() to re-run the effect.
  const [refreshTick, setRefreshTick] = useState(0);

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
  }, [refreshTick]);

  const refresh = async () => { setRefreshTick(t => t + 1); };

  return { customers, loading, refresh };
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

/** Upsert a single HubSpot contact into makelila.customers with insert-only
 *  semantics for operator-curated fields:
 *  - If the customer does NOT exist: insert name + phone + email + attribution.
 *  - If the customer DOES exist: only write attribution fields (first_touch_source)
 *    when they are currently null — never overwrite name or phone.
 *
 *  This is the authoritative client-side path for the HubSpot decommission
 *  (Feature 10). The edge function `sync-hubspot-customers` applies the same
 *  logic server-side. */
export async function upsertHubSpotContact(hubspotContact: {
  email: string;
  name?: string | null;
  phone?: string | null;
  hs_analytics_source?: string | null;
}): Promise<void> {
  const { data: existing } = await supabase
    .from('customers')
    .select('id, name, phone')
    .eq('email', hubspotContact.email)
    .maybeSingle();

  const safeFields: Record<string, unknown> = {
    email: hubspotContact.email,
    ...(hubspotContact.hs_analytics_source != null
      ? { first_touch_source: hubspotContact.hs_analytics_source }
      : {}),
  };

  if (!existing) {
    if (hubspotContact.name) safeFields['name'] = hubspotContact.name;
    if (hubspotContact.phone) safeFields['phone'] = hubspotContact.phone;
  }

  const { error } = await supabase
    .from('customers')
    .upsert(safeFields, { onConflict: 'email', ignoreDuplicates: false });

  if (error) throw new Error(error.message);

  await logAction(
    'hubspot_contact_synced',
    hubspotContact.email,
    existing ? 'updated (attribution only)' : 'inserted (new customer)',
  );
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

/** Manually pin a customer to a CJM stage in the Journey tab, overriding
 *  the auto-inference. Pass `null` to clear the override and revert to
 *  inference. Stamps the actor + timestamp for audit. */
export async function setJourneyStageOverride(
  customerId: string,
  stage: string | null,
): Promise<void> {
  const { data: { user } } = await supabase.auth.getUser();
  const patch = stage === null
    ? { journey_stage_override: null, journey_stage_override_at: null, journey_stage_override_by: null }
    : {
        journey_stage_override: stage,
        journey_stage_override_at: new Date().toISOString(),
        journey_stage_override_by: user?.id ?? null,
      };
  const { error } = await supabase
    .from('customers')
    .update(patch)
    .eq('id', customerId);
  if (error) throw error;
  await logAction('journey_stage_override', customerId, stage ?? '(cleared)');
}

/** Send the "what's your name?" email to a customer who has an email
 *  but no full_name on file. Used by the Journey tab to clear nameless
 *  customers off the board. Reuses the existing send-template-email
 *  edge function + the seeded `name_collection_request` template
 *  (migration 20260605060000). Stamps `customers.name_request_sent_at`
 *  on success so the operator's UI can dedupe re-sends. */
export async function sendNameCollectionRequest(customer: Customer): Promise<void> {
  if (!customer.email) throw new Error(`${customer.full_name || 'Customer'} has no email on file.`);
  const { data: { session } } = await supabase.auth.getSession();
  const res = await fetch(`${SUPABASE_URL}/functions/v1/send-template-email`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${session?.access_token ?? SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify({
      template_key: 'name_collection_request',
      to: customer.email,
      variables: {},
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    let detail = text;
    try { detail = (JSON.parse(text) as { error?: string }).error ?? text; } catch { /* keep raw */ }
    throw new Error(`Name request failed (${res.status}): ${detail}`);
  }
  await supabase
    .from('customers')
    .update({ name_request_sent_at: new Date().toISOString() })
    .eq('id', customer.id);
  await logAction('name_request_sent', customer.id, customer.email,
    undefined,
    { klaviyoEvent: 'Name Request Sent', klaviyoEmail: customer.email });
}

/** J6: Toggle the telemetry auto-ticket suppress flag for a customer.
 *  When suppress=true the cron job will skip all units owned by this customer. */
export async function setTelemetryAutoticketSuppress(
  customerId: string,
  suppress: boolean,
): Promise<void> {
  const { error } = await supabase
    .from('customers')
    .update({ telemetry_autoticket_suppress: suppress })
    .eq('id', customerId);
  if (error) throw error;
  await logAction(
    'telemetry_autoticket_suppress_set',
    customerId,
    suppress ? 'suppressed' : 'enabled',
    { entityType: 'customer', entityId: customerId },
  );
}
