import { useEffect, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase';
import { logAction } from './activityLog';
import { DEFAULT_RATES, type ProfitabilityRates, type AcquisitionSpendRow } from './profitability';

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
  // FR-6: the PRIMARY USER of this customer's machine (e.g. a spouse) when
  // different from the purchaser/account holder. Free-text — the primary user is
  // usually not a customer of record. Surfaced on the refund card.
  primary_user_name: string | null;
  primary_user_phone: string | null;
  primary_user_email: string | null;
  // How that primary user relates to the purchaser (e.g. 'Spouse / partner').
  // Text, not an enum — the UI picklist has an "Other…" free-text escape.
  primary_user_relationship: string | null;
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

// FR-6: resolve who a refund card is about. Every card has a PURCHASER (the
// accounting entity) and a PRIMARY USER of the machine; by default the customer
// who filed the form is BOTH, and we only split them when there's an explicit
// link — a purchaser link (gift/household), or a separately-named primary user
// (e.g. Chad bought it, Sarah uses it). No "unconfirmed" state: the labels are
// always definite. `filerIs*` flags say which role the person who filled out the
// form holds, so the card can make that clear.
type CustLite = { id: string; full_name: string; purchaser_id: string | null; primary_user_name: string | null };
export type RefundParties = {
  purchaser: string;
  primaryUser: string;      // defaults to the purchaser when none is linked
  filer: string;            // who filled out the form
  samePerson: boolean;      // purchaser === primaryUser
  filerIsPurchaser: boolean;
  filerIsPrimaryUser: boolean;
};

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export function resolveRefundParties(opts: {
  filerEmail: string | null | undefined;
  filerName: string;
  byEmail: Map<string, CustLite>;
  byId: Map<string, { full_name: string; primary_user_name: string | null }>;
  // return-form attestation, used only when the filer isn't in the directory:
  attestIsPurchaser?: boolean | null;
  attestPurchaserName?: string | null;
}): RefundParties {
  const e = (opts.filerEmail ?? '').toLowerCase().trim();
  const filerCust = e ? opts.byEmail.get(e) : undefined;
  const filer = (filerCust?.full_name || opts.filerName || '').trim() || opts.filerName;

  let purchaser: string;
  let ownerPrimaryUserName: string | null = null;
  let filerIsPurchaser: boolean;

  if (filerCust?.purchaser_id) {
    // Filer is a linked user acting for a purchaser (gift/household).
    const owner = opts.byId.get(filerCust.purchaser_id);
    purchaser = (owner?.full_name || '').trim() || filer;
    ownerPrimaryUserName = owner?.primary_user_name?.trim() || null;
    filerIsPurchaser = false;
  } else if (filerCust) {
    // Filer is a known customer and their own purchaser.
    purchaser = (filerCust.full_name || '').trim() || filer;
    ownerPrimaryUserName = filerCust.primary_user_name?.trim() || null;
    filerIsPurchaser = true;
  } else if (opts.attestIsPurchaser === false && opts.attestPurchaserName?.trim()) {
    // Not in the directory, but the form says the filer isn't the buyer.
    purchaser = opts.attestPurchaserName.trim();
    filerIsPurchaser = false;
  } else {
    // Default: the filer is the purchaser.
    purchaser = filer;
    filerIsPurchaser = true;
  }

  // Primary user: an explicitly-named one wins; else the acting filer (when they
  // aren't the purchaser); else the purchaser is also the primary user.
  const primaryUser = ownerPrimaryUserName ?? (!filerIsPurchaser ? filer : purchaser);

  return {
    purchaser,
    primaryUser,
    filer,
    samePerson: sameName(purchaser, primaryUser),
    filerIsPurchaser,
    filerIsPrimaryUser: sameName(primaryUser, filer),
  };
}

// ── Card contact block (email / phone / address) ────────────────────────────
// Every refund card has to say how to reach the customer. The case records
// themselves are thin: a refund carries an email at best, a return form adds a
// phone, and NEITHER ever carries an address — so the customer directory is
// what fills the gaps. Case data wins where it exists (an operator may have
// corrected it on the form); the directory backfills the rest. Nothing here
// invents a value: a field with nothing behind it comes back null so the card
// can say it isn't on file.

export type CustomerContact = {
  email: string | null;
  phone: string | null;
  address: string | null;
};

/** The directory columns a contact block reads. */
export type ContactDirectoryRow = Pick<
  Customer,
  'email' | 'phone' | 'address_line' | 'city' | 'region' | 'postal_code' | 'country'
>;

const trimmed = (v: string | null | undefined): string | null => (v ?? '').trim() || null;

/** One-line mailing address from a directory row, skipping the parts that are
 *  blank. Null when the row has no address parts at all. */
export function formatCustomerAddress(
  row: Partial<ContactDirectoryRow> | null | undefined,
): string | null {
  if (!row) return null;
  const parts = [row.address_line, row.city, row.region, row.postal_code, row.country]
    .map(trimmed)
    .filter((p): p is string => p !== null);
  return parts.length ? parts.join(', ') : null;
}

/** The best email / phone / address we have for the person a card is about. */
export function resolveCustomerContact(opts: {
  caseEmail?: string | null;
  casePhone?: string | null;
  directory?: Partial<ContactDirectoryRow> | null;
}): CustomerContact {
  return {
    email: trimmed(opts.caseEmail) ?? trimmed(opts.directory?.email),
    phone: trimmed(opts.casePhone) ?? trimmed(opts.directory?.phone),
    address: formatCustomerAddress(opts.directory),
  };
}

export type ContactIndex<T> = { byEmail: Map<string, T>; byName: Map<string, T> };

/** Index the directory for contact lookups. Email is the real key; the name
 *  index is the fallback for cards that never captured an email. A name shared
 *  by two customers is dropped from the name index — guessing which household
 *  a card belongs to would put a stranger's address on it. */
export function buildContactIndex<T extends { email: string | null; full_name: string }>(
  rows: T[],
): ContactIndex<T> {
  const byEmail = new Map<string, T>();
  const byName = new Map<string, T>();
  const ambiguous = new Set<string>();
  for (const row of rows) {
    const email = trimmed(row.email)?.toLowerCase();
    if (email && !byEmail.has(email)) byEmail.set(email, row);
    const name = trimmed(row.full_name)?.toLowerCase();
    if (!name) continue;
    if (byName.has(name)) { ambiguous.add(name); continue; }
    byName.set(name, row);
  }
  for (const name of ambiguous) byName.delete(name);
  return { byEmail, byName };
}

/** Find a card's directory row: by email, else by an unambiguous full name. */
export function lookupContactRow<T>(
  index: ContactIndex<T>,
  opts: { email?: string | null; name?: string | null },
): T | null {
  const email = trimmed(opts.email)?.toLowerCase();
  if (email) {
    const hit = index.byEmail.get(email);
    if (hit) return hit;
  }
  const name = trimmed(opts.name)?.toLowerCase();
  return (name && index.byName.get(name)) || null;
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
  if (serial !== undefined) {
    // The panel edits a single serial, but serials[] can legitimately hold
    // several (a customer who owns two machines, or who has been through a
    // replacement). Writing [serial] wholesale used to silently drop every
    // other entry, so replace only the first element and keep the rest.
    const next = serial.trim();
    const { data: existing } = await supabase
      .from('customers').select('serials').eq('id', customerId).single();
    const rest_serials = ((existing?.serials as string[] | null) ?? []).slice(1);
    update.serials = next ? [next, ...rest_serials] : rest_serials;
  }
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
  // V9: province/state, read off the first sale order's ship-to (present on
  // every sale order) and folded to a two-letter code. region_code prefixes
  // the country — 'CA-ON' vs 'US-CA' — because 'CA' alone is ambiguous.
  region: string | null;
  region_code: string | null;
  onboard_date: string | null;
  // V9: acquisition. Channel is the first sale order's UTM attribution
  // collapsed to a budgetable bucket; later orders are upsells and must not
  // re-attribute the customer. acquired_on anchors every cohort.
  acquisition_channel: string;
  acquisition_campaign: string | null;
  first_order_at: string | null;
  last_order_at: string | null;
  acquired_on: string | null;
  // V5: every amount is CAD, converted through public.fx_rates. The V4 `_usd`
  // names were a misnomer on three of the four inputs — orders.total_usd/tax_usd
  // follow orders.currency, cogs_usd is USD, shipping_cost_usd is CAD.
  // Revenue (net of tax — tax is pass-through to govt and not VCycene income)
  revenue_cad: number;
  // V9 revenue detail. gross is what list price would have been, so
  // discount / gross is the discount rate. initial is the original machine
  // purchase; everything after it is upsell.
  gross_revenue_cad: number;
  discount_cad: number;
  initial_revenue_cad: number;
  initial_discount_cad: number;
  upsell_revenue_cad: number;
  // Always 0 today — LILA sells no subscription or service plan. Kept as a
  // column so the model is ready rather than reshaped later.
  recurring_revenue_cad: number;
  // Sales tax collected on behalf of govt — informational, NOT part of margin
  tax_collected_cad: number;
  // 4 cost buckets — sale_cogs + sale_shipping are sales-only;
  // expected_warranty covers ALL non-cancelled replacement orders;
  // expected_refund covers ALL non-denied refund approvals.
  sale_cogs_cad: number;
  sale_shipping_cad: number;
  expected_warranty_cost_cad: number;
  expected_refund_cad: number;
  // V6 5th bucket: diagnosis-call labour, from public.diagnosis_calls.
  // NULL — not 0 — while support_rates.hourly_cad is unset, so the card can
  // distinguish "no calls" from "we haven't priced a person-hour yet".
  support_cost_cad: number | null;
  // V8 6th bucket: what it costs US to take a unit back — stocking +
  // inspection + the return freight leg. Not to be confused with
  // refund_approvals.restocking_fee_usd, which is a fee charged TO the
  // customer and already nets out of expected_refund_cad.
  return_handling_cad: number | null;
  return_stocking_cad: number | null;
  return_inspection_cad: number | null;
  return_freight_cad: number | null;
  // Returns where the unit physically came back. Customer-discarded returns
  // are excluded — nothing shipped, so there was nothing to stock or inspect.
  returns_handled: number;
  // V9 buckets 7-9, priced from public.profitability_rates. All three are
  // rated 0 until Finance sets them, and the UI says "unpriced" rather than
  // letting the 0 read as "free".
  payment_fee_cad: number;
  sales_commission_cad: number;
  installation_cost_cad: number;
  // Bucket 10: consumables and repair parts bought at retail and drop-shipped
  // to the customer (Amazon worm castings, jumper caps). Cost of goods, not
  // freight -- the money buys product the customer keeps.
  consumables_cost_cad: number;
  consumable_item_count: number;
  // Bucket 11: 3PL per-order handling (FlexSpace) -- order fee + picks.
  // ESTIMATED from the contracted rate card, not from an invoice. Excludes
  // transportation, which the 3PL passes through and bucket 2 already holds.
  fulfilment_cost_cad: number;
  fulfilment_order_count: number;
  // Margin = revenue - all 10 buckets (no double-count)
  net_margin_cad: number;
  // Settled-refund subset (status='refunded' only) — shown alongside
  // expected so operators can see in-flight vs booked.
  settled_refund_cad: number;
  // Counts
  order_count: number;
  // Sale orders with a unit traced to them. Lower than order_count whenever an
  // order has not shipped, or its unit was never linked to the order ref.
  units_shipped_count: number;
  replacement_count: number;
  open_replacement_count: number;
  // Cost coverage. COGS is always filled, but batch_actual is the invoiced
  // landed cost while schedule is the V-SAX roadmap projection. Shipping can
  // still be genuinely unknown — shipping_uncosted_count > 0 means this
  // customer's margin is an upper bound.
  cogs_actual_count: number;
  cogs_modelled_count: number;
  shipping_costed_count: number;
  shipping_uncosted_count: number;
  // Sale orders whose freight came from a Freightcom invoice rather than the
  // booking quote. The quote is never revised when an adjustment lands.
  shipping_invoiced_count: number;
  // Pre-Freightcom freight (Canpar/GLS/Purolator/FedEx, Oct 2025 - Jan 2026).
  // Attributed per customer, because most of that cohort has no order record.
  // Part of the shipping bucket, held separately so it stays auditable.
  legacy_shipping_cad: number;
  legacy_shipment_count: number;
  refund_count: number;
  in_flight_refund_count: number;
  ticket_count: number;
  // Leading indicator: open warranty/defect tickets with no replacement
  // order yet — expected_warranty will grow when these convert.
  open_warranty_ticket_count: number;
  // Every diagnosis call and the total time on them, no-shows included —
  // support_cost_cad bills both the same way.
  diagnosis_call_count: number;
  diagnosis_minutes: number;
  // Subset of diagnosis_call_count the customer never joined, not additional
  // to it. Billed, but surfaced separately so the waste stays legible.
  diagnosis_noshow_count: number;
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
        .order('net_margin_cad', { ascending: false });
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
        revenue_cad:                Number(r.revenue_cad ?? 0),
        gross_revenue_cad:          Number(r.gross_revenue_cad ?? 0),
        discount_cad:               Number(r.discount_cad ?? 0),
        initial_revenue_cad:        Number(r.initial_revenue_cad ?? 0),
        initial_discount_cad:       Number(r.initial_discount_cad ?? 0),
        upsell_revenue_cad:         Number(r.upsell_revenue_cad ?? 0),
        recurring_revenue_cad:      Number(r.recurring_revenue_cad ?? 0),
        payment_fee_cad:            Number(r.payment_fee_cad ?? 0),
        sales_commission_cad:       Number(r.sales_commission_cad ?? 0),
        installation_cost_cad:      Number(r.installation_cost_cad ?? 0),
        consumables_cost_cad:       Number(r.consumables_cost_cad ?? 0),
        fulfilment_cost_cad:        Number(r.fulfilment_cost_cad ?? 0),
        fulfilment_order_count:     Number(r.fulfilment_order_count ?? 0),
        consumable_item_count:      Number(r.consumable_item_count ?? 0),
        shipping_invoiced_count:    Number(r.shipping_invoiced_count ?? 0),
        legacy_shipping_cad:        Number(r.legacy_shipping_cad ?? 0),
        legacy_shipment_count:      Number(r.legacy_shipment_count ?? 0),
        units_shipped_count:        Number(r.units_shipped_count ?? 0),
        acquisition_channel:        (r.acquisition_channel as string) ?? 'unknown',
        tax_collected_cad:          Number(r.tax_collected_cad ?? 0),
        sale_cogs_cad:              Number(r.sale_cogs_cad ?? 0),
        sale_shipping_cad:          Number(r.sale_shipping_cad ?? 0),
        expected_warranty_cost_cad: Number(r.expected_warranty_cost_cad ?? 0),
        expected_refund_cad:        Number(r.expected_refund_cad ?? 0),
        // Preserve null: it means the rate is unset, not that support was free.
        support_cost_cad:           r.support_cost_cad == null ? null : Number(r.support_cost_cad),
        return_handling_cad:        r.return_handling_cad == null ? null : Number(r.return_handling_cad),
        return_stocking_cad:        r.return_stocking_cad == null ? null : Number(r.return_stocking_cad),
        return_inspection_cad:      r.return_inspection_cad == null ? null : Number(r.return_inspection_cad),
        return_freight_cad:         r.return_freight_cad == null ? null : Number(r.return_freight_cad),
        returns_handled:            Number(r.returns_handled ?? 0),
        diagnosis_call_count:       Number(r.diagnosis_call_count ?? 0),
        diagnosis_minutes:          Number(r.diagnosis_minutes ?? 0),
        diagnosis_noshow_count:     Number(r.diagnosis_noshow_count ?? 0),
        settled_refund_cad:         Number(r.settled_refund_cad ?? 0),
        net_margin_cad:             Number(r.net_margin_cad ?? 0),
        cogs_actual_count:          Number(r.cogs_actual_count ?? 0),
        cogs_modelled_count:        Number(r.cogs_modelled_count ?? 0),
        shipping_costed_count:      Number(r.shipping_costed_count ?? 0),
        shipping_uncosted_count:    Number(r.shipping_uncosted_count ?? 0),
      })) as CustomerProfitability[];
      setRows(coerced);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  return { rows, loading, error };
}

// ── Profitability inputs: rates and acquisition spend ───────────────────────
// Both are small reference tables read once. They feed lib/profitability.ts,
// which is where every formula that needs more than one customer lives.

/** public.profitability_rates, keyed for direct use by the calc layer. */
export function useProfitabilityRates(): {
  rates: ProfitabilityRates;
  loading: boolean;
  error: Error | null;
} {
  const [rates, setRates] = useState<ProfitabilityRates>(DEFAULT_RATES);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error: err } = await supabase
        .from('profitability_rates')
        .select('key, value');
      if (cancelled) return;
      if (err) {
        // A missing rates table must not blank the dashboard — fall back to
        // the defaults, which are all zero, and let the UI flag them unpriced.
        setError(err as unknown as Error);
        setLoading(false);
        return;
      }
      const next = { ...DEFAULT_RATES };
      for (const row of (data ?? []) as { key: string; value: unknown }[]) {
        if (row.key in next) {
          (next as unknown as Record<string, number>)[row.key] = Number(row.value ?? 0);
        }
      }
      setRates(next);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  return { rates, loading, error };
}

/** public.acquisition_spend_monthly — Meta spend plus any hand-entered rows. */
export function useAcquisitionSpend(): {
  spend: AcquisitionSpendRow[];
  loading: boolean;
  error: Error | null;
} {
  const [spend, setSpend] = useState<AcquisitionSpendRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error: err } = await supabase
        .from('acquisition_spend_monthly')
        .select('*')
        .order('month', { ascending: true });
      if (cancelled) return;
      if (err) {
        setError(err as unknown as Error);
        setLoading(false);
        return;
      }
      setSpend((data ?? []).map((r: Record<string, unknown>) => ({
        channel:   String(r.channel ?? 'unknown'),
        month:     String(r.month ?? ''),
        spend_cad: Number(r.spend_cad ?? 0),
        source:    String(r.source ?? 'manual'),
      })));
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  return { spend, loading, error };
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

/** Picklist for the primary user's relationship to the purchaser. Backed by a
 *  plain text column, so this list can grow without a migration; the UI also
 *  offers "Other…" for anything not covered here. */
export const PRIMARY_USER_RELATIONSHIPS = [
  'Spouse / partner',
  'Parent',
  'Child',
  'Sibling',
  // "Extended family", not "Other family member" — the picklist already ends in
  // an "Other…" escape and two options starting with "Other" read as a mistake.
  'Extended family',
  'Roommate / housemate',
  'Friend',
  'Employee / staff',
  'Property manager / caretaker',
] as const;

/** FR-6: set (or clear) the primary user of this customer's machine — a person
 *  who is usually not a customer of record (e.g. a spouse), so free-text.
 *  `relationship` is how they relate to the purchaser (see
 *  PRIMARY_USER_RELATIONSHIPS; any string is accepted for the "Other…" case). */
export async function setPrimaryUser(
  customerId: string,
  name: string | null,
  phone: string | null,
  email: string | null,
  relationship: string | null,
): Promise<void> {
  const { error } = await supabase.from('customers').update({
    primary_user_name: name?.trim() || null,
    primary_user_phone: phone?.trim() || null,
    primary_user_email: email?.trim() || null,
    primary_user_relationship: relationship?.trim() || null,
  }).eq('id', customerId);
  if (error) throw error;
  const rel = relationship?.trim();
  await logAction(
    'customer_primary_user_set',
    customerId,
    name?.trim() ? `${name.trim()}${rel ? ` (${rel})` : ''}` : 'cleared',
    { entityType: 'customer', entityId: customerId },
  );
}

// ── Other users in the household ────────────────────────────────────────────
// primary_user_* holds ONE person. A household often has more: the purchaser
// stays the primary user and a spouse/child/roommate is also someone we're in
// contact with. Those live in customer_additional_users — free text, because
// like the primary user they're usually not customers of record.

export type CustomerAdditionalUser = {
  id: string;
  customer_id: string;
  full_name: string;
  phone: string | null;
  email: string | null;
  /** How they relate to the purchaser. See PRIMARY_USER_RELATIONSHIPS — text,
   *  so the UI's "Other…" free-text escape can store anything. */
  relationship: string | null;
  created_at: string;
  updated_at: string;
};

/** The household users for one customer, oldest first. Pass null when no
 *  customer is selected — the hook then idles with an empty list. */
export function useCustomerAdditionalUsers(customerId: string | null): {
  users: CustomerAdditionalUser[];
  loading: boolean;
  refresh: () => Promise<void>;
} {
  const [users, setUsers] = useState<CustomerAdditionalUser[]>([]);
  const [loading, setLoading] = useState(customerId !== null);
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    if (!customerId) { setUsers([]); setLoading(false); return; }
    let channel: RealtimeChannel | null = null;
    let cancelled = false;
    setLoading(true);
    (async () => {
      const { data, error } = await supabase
        .from('customer_additional_users')
        .select('*')
        .eq('customer_id', customerId)
        .order('created_at', { ascending: true });
      if (cancelled) return;
      if (!error && data) setUsers(data as CustomerAdditionalUser[]);
      setLoading(false);

      // Two operators can have the same customer open; keep both lists live.
      // The channel name is per-customer so switching customers tears down the
      // old subscription instead of stacking filters.
      channel = supabase
        .channel(`customer_additional_users:${customerId}`)
        .on('postgres_changes', {
          event: '*', schema: 'public', table: 'customer_additional_users',
          filter: `customer_id=eq.${customerId}`,
        }, (payload) => {
          setUsers(prev => {
            if (payload.eventType === 'DELETE' && payload.old) {
              return prev.filter(u => u.id !== (payload.old as { id: string }).id);
            }
            if (payload.new) {
              const row = payload.new as CustomerAdditionalUser;
              const idx = prev.findIndex(u => u.id === row.id);
              if (idx >= 0) { const next = [...prev]; next[idx] = row; return next; }
              return [...prev, row].sort((a, b) => a.created_at.localeCompare(b.created_at));
            }
            return prev;
          });
        })
        .subscribe();
    })();
    return () => { cancelled = true; if (channel) void channel.unsubscribe(); };
  }, [customerId, refreshTick]);

  const refresh = async () => { setRefreshTick(t => t + 1); };

  return { users, loading, refresh };
}

/** Fields an operator can set on a household user. */
export type AdditionalUserInput = {
  full_name: string;
  phone?: string | null;
  email?: string | null;
  relationship?: string | null;
};

/** Trim to the shape the table wants: blanks become NULL, never ''. */
function normalizeAdditionalUser(input: AdditionalUserInput) {
  return {
    full_name: input.full_name.trim(),
    phone: input.phone?.trim() || null,
    email: input.email?.trim() || null,
    relationship: input.relationship?.trim() || null,
  };
}

/** One-line audit detail: "Sarah Lockhart (Spouse / partner)". */
function additionalUserLabel(row: { full_name: string; relationship: string | null }): string {
  return row.relationship ? `${row.full_name} (${row.relationship})` : row.full_name;
}

/** Add another person in this customer's household. */
export async function addCustomerAdditionalUser(
  customerId: string,
  input: AdditionalUserInput,
): Promise<CustomerAdditionalUser> {
  const row = normalizeAdditionalUser(input);
  if (!row.full_name) throw new Error('A name is required.');
  const { data, error } = await supabase
    .from('customer_additional_users')
    .insert({ customer_id: customerId, ...row })
    .select()
    .single();
  if (error) throw error;
  await logAction(
    'customer_additional_user_added',
    customerId,
    additionalUserLabel(row),
    { entityType: 'customer', entityId: customerId },
  );
  return data as CustomerAdditionalUser;
}

/** Edit a household user in place. */
export async function updateCustomerAdditionalUser(
  id: string,
  customerId: string,
  input: AdditionalUserInput,
): Promise<void> {
  const row = normalizeAdditionalUser(input);
  if (!row.full_name) throw new Error('A name is required.');
  const { error } = await supabase
    .from('customer_additional_users')
    .update(row)
    .eq('id', id);
  if (error) throw error;
  await logAction(
    'customer_additional_user_updated',
    customerId,
    additionalUserLabel(row),
    { entityType: 'customer', entityId: customerId },
  );
}

/** Remove a household user. `name` is passed in only so the audit line stays
 *  readable after the row is gone. */
export async function removeCustomerAdditionalUser(
  id: string,
  customerId: string,
  name: string,
): Promise<void> {
  const { error } = await supabase
    .from('customer_additional_users')
    .delete()
    .eq('id', id);
  if (error) throw error;
  await logAction(
    'customer_additional_user_removed',
    customerId,
    name,
    { entityType: 'customer', entityId: customerId },
  );
}

// ── Operator-editable contact details ───────────────────────────────────────
// makelila is the system of record (docs/system-of-record.md): HubSpot's sync
// only FILLS BLANK columns on an existing row and never clobbers a curated
// value, and no other sync writes customers.email / customers.phone. So an
// operator correction here sticks.

/** Loose sanity check — we're catching typos, not policing valid addresses. */
export function isPlausibleEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

/** Correct a customer's own email / phone from the directory. Email is the key
 *  this app matches orders, tickets and refund cards on, so a duplicate would
 *  silently merge two people's histories — that's rejected here rather than
 *  left to a DB constraint (there is no unique index on customers.email). */
export async function updateCustomerContact(
  customerId: string,
  patch: { email?: string | null; phone?: string | null },
): Promise<void> {
  const update: Record<string, string | null> = {};

  if (patch.email !== undefined) {
    const email = patch.email?.trim().toLowerCase() || null;
    if (email && !isPlausibleEmail(email)) {
      throw new Error(`"${email}" doesn't look like an email address.`);
    }
    if (email) {
      const { data: clash, error: clashErr } = await supabase
        .from('customers')
        .select('id, full_name')
        .ilike('email', email)
        .neq('id', customerId)
        .limit(1);
      if (clashErr) throw clashErr;
      const other = (clash ?? [])[0] as { id: string; full_name: string } | undefined;
      if (other) {
        throw new Error(
          `${other.full_name || 'Another customer'} already uses ${email}. ` +
          `Two customers can't share an email — orders and tickets are matched on it. ` +
          `Link them as purchaser/user instead, or fix the other record first.`,
        );
      }
    }
    update.email = email;
  }

  if (patch.phone !== undefined) update.phone = patch.phone?.trim() || null;
  if (Object.keys(update).length === 0) return;

  const { error } = await supabase.from('customers').update(update).eq('id', customerId);
  if (error) throw error;
  await logAction('customer_contact_updated', customerId, Object.keys(update).join(', '),
    { entityType: 'customer', entityId: customerId });
}


// ── Name correction ─────────────────────────────────────────────────────────
// customers.full_name is a generated column, so fixing first_name / last_name
// fixes every screen reading the customers row. Eleven other tables hold a
// denormalized customer_name snapshot and several match back to the customer BY
// that string, so the rename has to cascade or the record is orphaned, not just
// mislabelled. All of that happens inside the rename_customer RPC (migration
// 20260813090000) in one transaction.
// Spec: docs/superpowers/specs/2026-08-13-customer-name-editing-design.md

/** A row the rename left alone because its only key was a name another
 *  customer also answers to. `id` is that table's primary key. */
export type CustomerRenameSkip = { table: string; id: string; label: string | null };

export type CustomerRenameResult = {
  old_name: string;
  new_name: string;
  /** True when another customer shares the old name. Name-only matching is
   *  suppressed in that case and the affected rows land in `skipped`. */
  ambiguous: boolean;
  /** table name → rows whose customer_name changed. Tables with no changes
   *  are omitted. */
  updated: Record<string, number>;
  skipped: CustomerRenameSkip[];
};

async function callRenameCustomer(
  customerId: string,
  firstName: string,
  lastName: string,
  dryRun: boolean,
): Promise<CustomerRenameResult> {
  const { data, error } = await supabase.rpc('rename_customer', {
    p_customer_id: customerId,
    p_first_name: firstName,
    p_last_name: lastName,
    p_dry_run: dryRun,
  });
  if (error) throw new Error(error.message);
  const r = (data ?? {}) as Partial<CustomerRenameResult>;
  return {
    old_name: r.old_name ?? '',
    new_name: r.new_name ?? '',
    ambiguous: r.ambiguous ?? false,
    updated: r.updated ?? {},
    skipped: r.skipped ?? [],
  };
}

/** Total rows a rename touches across every table. */
export function renameRowCount(result: CustomerRenameResult): number {
  return Object.values(result.updated).reduce((a, b) => a + b, 0);
}

/** Dry run: what a rename WOULD change, writing nothing. Shares its predicate
 *  with the real thing, so the confirm dialog can't promise the wrong number. */
export function previewCustomerRename(
  customerId: string, firstName: string, lastName: string,
): Promise<CustomerRenameResult> {
  return callRenameCustomer(customerId, firstName, lastName, true);
}

/** Apply the rename and every cascade. Throws if both names are blank — that
 *  would erase the key the cascades match on. */
export async function renameCustomer(
  customerId: string, firstName: string, lastName: string,
): Promise<CustomerRenameResult> {
  const result = await callRenameCustomer(customerId, firstName, lastName, false);
  await logAction(
    'customer_renamed',
    customerId,
    `${result.old_name || '(no name)'} → ${result.new_name} (${renameRowCount(result)} records)`,
    { entityType: 'customer', entityId: customerId },
  );
  return result;
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
