import { useEffect, useMemo, useState } from 'react';
import { supabase } from './supabase';
import { useCustomers, computeFuState, FU1_DAYS, FU2_DAYS, type FuState, type Customer } from './customers';
import { useServiceTickets, type ServiceTicket } from './service';
import { useQueuedReplacements } from './orders';

export type FollowUpStatusKey =
  | 'overdue' | 'due_today' | 'due_7d' | 'fu_on_hold'
  | 'in_followup' | 'awaiting_onboarding' | 'awaiting_response'
  | 'awaiting_diagnosis' | 'queued_replacement' | 'on_hold'
  | 'awaiting_review' | 'active' | 'returned';

export const STATUS_FILTERS: { key: FollowUpStatusKey; label: string }[] = [
  { key: 'overdue',             label: 'Overdue' },
  { key: 'due_today',           label: 'Due today' },
  { key: 'due_7d',              label: 'Due in 7 days' },
  { key: 'fu_on_hold',          label: 'Follow-up on hold' },
  { key: 'in_followup',         label: 'In follow-up' },
  { key: 'awaiting_onboarding', label: 'Awaiting onboarding' },
  { key: 'awaiting_response',   label: 'Awaiting response' },
  { key: 'awaiting_diagnosis',  label: 'Awaiting diagnosis' },
  { key: 'queued_replacement',  label: 'Queued for replacement' },
  { key: 'on_hold',             label: 'On hold' },
  { key: 'awaiting_review',     label: 'Awaiting review' },
  { key: 'active',              label: 'Active' },
  { key: 'returned',            label: 'Returned' },
];

export type CustomerStatusContext = {
  openTickets: Pick<ServiceTicket, 'status' | 'category'>[];
  queuedReplacement: boolean;
  returned: boolean;
  awaitingOnboarding: boolean;
};

/** Days until the customer's next still-pending follow-up, or null if none
 *  pending (unscheduled or both complete). Negative = overdue. */
function daysToNextFu(c: Customer, today: Date): number | null {
  if (!c.onboard_date) return null;
  const onboard = new Date(c.onboard_date + 'T00:00:00');
  const mid = new Date(today); mid.setHours(0, 0, 0, 0);
  const due = (days: number) => { const d = new Date(onboard); d.setDate(d.getDate() + days); return d; };
  const dayDiff = (d: Date) => Math.round((d.getTime() - mid.getTime()) / 86_400_000);
  if (!c.fu1_status) return dayDiff(due(FU1_DAYS));
  if (!c.fu2_status) return dayDiff(due(FU2_DAYS));
  return null;
}

/** The set of Follow-Ups directory status keys a customer belongs to. Pure. */
export function computeCustomerStatuses(
  c: Customer, ctx: CustomerStatusContext, today: Date = new Date(),
): Set<FollowUpStatusKey> {
  const s = new Set<FollowUpStatusKey>();
  const fu = computeFuState(c, today);

  // A pending follow-up is put ON HOLD while the customer has an unresolved
  // issue — a queued replacement or an open support/repair/diagnosis ticket.
  // Onboarding-call tickets don't block. Resumes automatically once resolved.
  const BLOCKING_TICKET_CATEGORIES = ['support', 'repair', 'diagnosis_call'];
  const blockingCondition =
    ctx.queuedReplacement
    || ctx.openTickets.some(t => BLOCKING_TICKET_CATEGORIES.includes(t.category as string));
  const pendingFu = !!c.onboard_date && fu !== 'complete' && fu !== 'unscheduled';
  const fuBlocked = pendingFu && blockingCondition;

  if (fuBlocked) {
    s.add('fu_on_hold');
  } else {
    if (fu === 'overdue_fu1' || fu === 'overdue_fu2') s.add('overdue');
    if (fu === 'due_fu1' || fu === 'due_fu2') s.add('due_today');
    const dnext = daysToNextFu(c, today);
    if (dnext !== null && dnext > 0 && dnext <= 7) s.add('due_7d');
    if (c.onboard_date && fu !== 'complete' && fu !== 'unscheduled') s.add('in_followup');
  }

  const hasTicket = (pred: (t: { status: string; category: string }) => boolean) =>
    ctx.openTickets.some(t => pred(t as { status: string; category: string }));
  if (hasTicket(t => t.status === 'on_hold')) s.add('on_hold');
  if (hasTicket(t => t.status === 'waiting_on_customer')) s.add('awaiting_response');
  if (hasTicket(t => t.category === 'diagnosis_call')) s.add('awaiting_diagnosis');
  if (ctx.queuedReplacement || hasTicket(t => t.status === 'queued_for_replacement')) s.add('queued_replacement');

  if (ctx.awaitingOnboarding) s.add('awaiting_onboarding');
  if (c.review_status === 'requested') s.add('awaiting_review');
  if (ctx.returned) s.add('returned');

  const hasOpenIssue = ctx.openTickets.length > 0 || ctx.queuedReplacement || ctx.returned;
  if (c.onboard_date && fu === 'complete' && !hasOpenIssue) s.add('active');

  return s;
}

/** A row (ticket/order/return) that may attribute to a customer. */
export type Matchable = {
  customer_id?: string | null;
  customer_email?: string | null;
  customer_name?: string | null;
};

/** Candidate keys for matching a row to a customer, in precedence order:
 *  customer_id, then lowercased email, then lowercased name. */
export function matchKeysFor(m: Matchable): string[] {
  const keys: string[] = [];
  if (m.customer_id) keys.push(`id:${m.customer_id}`);
  if (m.customer_email) keys.push(`email:${m.customer_email.toLowerCase().trim()}`);
  if (m.customer_name) keys.push(`name:${m.customer_name.toLowerCase().trim()}`);
  return keys;
}

/** Build a Map from every match-key of a customer to that customer id. */
export function buildCustomerKeyIndex(customers: Customer[]): Map<string, string> {
  const idx = new Map<string, string>();
  for (const c of customers) {
    idx.set(`id:${c.id}`, c.id);
    if (c.email) idx.set(`email:${c.email.toLowerCase().trim()}`, c.id);
    if (c.full_name) idx.set(`name:${c.full_name.toLowerCase().trim()}`, c.id);
  }
  return idx;
}

/** Resolve a matchable row to a customer id using key precedence, or null. */
export function resolveCustomerId(m: Matchable, idx: Map<string, string>): string | null {
  for (const k of matchKeysFor(m)) { const id = idx.get(k); if (id) return id; }
  return null;
}

export type DirectoryRow = {
  customer: Customer;
  statuses: Set<FollowUpStatusKey>;
  fuState: FuState;
};

export function useFollowUpDirectory(today: Date = new Date()): {
  rows: DirectoryRow[];
  counts: Record<FollowUpStatusKey, number>;
  overdueCount: number;
  loading: boolean;
} {
  const { customers, loading: lc } = useCustomers();
  const { tickets, loading: lt } = useServiceTickets();
  const { replacements, loading: lr } = useQueuedReplacements();
  const [returnedKeys, setReturnedKeys] = useState<Set<string>>(new Set());
  const [awaitingOnboardingIds, setAwaitingOnboardingIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [{ data: refunds }, { data: lifecycle }] = await Promise.all([
        supabase.from('refund_approvals')
          .select('status, returns(customer_email, customer_name)')
          .eq('status', 'refunded'),
        supabase.from('customer_lifecycle')
          .select('customer_id, onboarding_status'),
      ]);
      if (cancelled) return;
      const rk = new Set<string>();
      for (const r of (refunds ?? []) as Array<{ returns: Array<{ customer_email: string | null; customer_name: string | null }> | { customer_email: string | null; customer_name: string | null } | null }>) {
        const rets = Array.isArray(r.returns) ? r.returns : r.returns ? [r.returns] : [];
        for (const ret of rets) {
          if (ret?.customer_email) rk.add(`email:${ret.customer_email.toLowerCase().trim()}`);
          if (ret?.customer_name) rk.add(`name:${ret.customer_name.toLowerCase().trim()}`);
        }
      }
      setReturnedKeys(rk);
      const ao = new Set<string>();
      for (const l of (lifecycle ?? []) as Array<{ customer_id: string | null; onboarding_status: string }>) {
        if (l.customer_id && l.onboarding_status !== 'completed') ao.add(l.customer_id);
      }
      setAwaitingOnboardingIds(ao);
    })().catch(() => { /* best-effort; leave sets empty */ });
    return () => { cancelled = true; };
  }, []);

  return useMemo(() => {
    const idx = buildCustomerKeyIndex(customers);
    const ticketsByCustomer = new Map<string, Pick<ServiceTicket, 'status' | 'category'>[]>();
    for (const t of tickets) {
      if (t.status === 'closed') continue;
      const cid = resolveCustomerId(t, idx);
      if (!cid) continue;
      const arr = ticketsByCustomer.get(cid);
      if (arr) arr.push(t); else ticketsByCustomer.set(cid, [t]);
    }
    const queuedIds = new Set<string>();
    for (const o of replacements) {
      const cid = resolveCustomerId(o as unknown as Matchable, idx);
      if (cid) queuedIds.add(cid);
    }
    const returnedIds = new Set<string>();
    for (const c of customers) {
      if (returnedKeys.has(`email:${(c.email ?? '').toLowerCase().trim()}`)
        || returnedKeys.has(`name:${(c.full_name ?? '').toLowerCase().trim()}`)) returnedIds.add(c.id);
    }

    const counts = Object.fromEntries(STATUS_FILTERS.map(f => [f.key, 0])) as Record<FollowUpStatusKey, number>;
    const rows: DirectoryRow[] = customers.map(c => {
      const ctx: CustomerStatusContext = {
        openTickets: ticketsByCustomer.get(c.id) ?? [],
        queuedReplacement: queuedIds.has(c.id),
        returned: returnedIds.has(c.id),
        awaitingOnboarding: awaitingOnboardingIds.has(c.id),
      };
      const statuses = computeCustomerStatuses(c, ctx, today);
      for (const k of statuses) counts[k] += 1;
      return { customer: c, statuses, fuState: computeFuState(c, today) };
    });
    rows.sort((a, b) =>
      Number(b.statuses.has('overdue')) - Number(a.statuses.has('overdue'))
      || a.customer.full_name.localeCompare(b.customer.full_name));

    return { rows, counts, overdueCount: counts.overdue, loading: lc || lt || lr };
  }, [customers, tickets, replacements, returnedKeys, awaitingOnboardingIds, today, lc, lt, lr]);
}
