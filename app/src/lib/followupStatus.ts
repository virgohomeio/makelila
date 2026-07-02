import { useEffect, useMemo, useState } from 'react';
import { supabase } from './supabase';
import { useCustomers, computeFuState, followUpDueDates, FU1_DAYS, FU2_DAYS, type FuState, type Customer } from './customers';
import { useServiceTickets, type ServiceTicket } from './service';
import { useQueuedReplacements } from './orders';

export type FollowUpStatusKey =
  | 'overdue' | 'due_today' | 'due_7d' | 'fu_on_hold' | 'diag_followup_due'
  | 'ticket_followup_due'
  | 'in_followup' | 'awaiting_onboarding' | 'awaiting_response'
  | 'awaiting_diagnosis' | 'queued_replacement' | 'on_hold'
  | 'awaiting_review' | 'active' | 'returned';

export const STATUS_FILTERS: { key: FollowUpStatusKey; label: string }[] = [
  { key: 'overdue',             label: 'Overdue' },
  { key: 'due_today',           label: 'Due today' },
  { key: 'due_7d',              label: 'Due in 7 days' },
  { key: 'fu_on_hold',          label: 'Follow-up on hold' },
  { key: 'diag_followup_due',   label: 'Diagnosis follow-up due' },
  { key: 'ticket_followup_due', label: 'Ticket follow-up due' },
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
  diagnosisCalls: { startIso: string | null; followupDoneAt: string | null }[];
  // The customer's most-recent CLOSED ticket (null if none). Drives the
  // ticket-specific follow-up scheduled 14 days after the ticket closed.
  lastClosedTicket?: { id: string; closedAt: string | null; followupDoneAt: string | null } | null;
  // Most-recent close date (ISO timestamp) across ALL ticket categories — not
  // just issue tickets. Anchors the FU1/FU2 reschedule once a hold lifts.
  // Distinct from lastClosedTicket, which is issue-only and drives the separate
  // post-close ticket follow-up.
  lastClosedAnyTicketAt?: string | null;
};

// Days after a ticket closes that its follow-up is due.
export const TICKET_FOLLOWUP_DAYS = 14;

// Ticket categories that are NOT "issue" tickets: onboarding is a pre-follow-up
// workflow, and diagnosis_call has its own dedicated follow-up handling. Open
// tickets in these categories do not hold follow-ups, and they don't anchor a
// post-close follow-up.
export const NON_ISSUE_TICKET_CATEGORIES = new Set(['onboarding', 'diagnosis_call']);
export const isIssueTicket = (t: { category: string }) => !NON_ISSUE_TICKET_CATEGORIES.has(t.category);

/** Due date (ISO) for the post-close ticket follow-up, or null if N/A. */
export function ticketFollowupDueDate(
  lastClosed: { closedAt: string | null; followupDoneAt: string | null } | null | undefined,
): Date | null {
  if (!lastClosed?.closedAt || lastClosed.followupDoneAt) return null;
  const due = new Date(lastClosed.closedAt);
  due.setDate(due.getDate() + TICKET_FOLLOWUP_DAYS);
  return due;
}

/** The date FU1/FU2 count from: `onboard_date`, shifted forward to a later
 *  ticket-close date when the customer had a blocking ticket that has since
 *  closed. Returns ISO `YYYY-MM-DD`, or null when unscheduled. */
export function effectiveFollowUpAnchor(c: Customer, ctx: CustomerStatusContext): string | null {
  if (!c.onboard_date) return null;
  // While any ticket is open the customer is on hold; the anchor isn't surfaced.
  if (ctx.openTickets.length > 0) return c.onboard_date;
  const closed = ctx.lastClosedAnyTicketAt?.slice(0, 10);
  if (closed && closed > c.onboard_date) return closed;
  return c.onboard_date;
}

/** Days until the customer's next still-pending follow-up, or null if none
 *  pending (unscheduled or both complete). Negative = overdue. Counts from
 *  `anchorIso` when given, otherwise `onboard_date`. */
function daysToNextFu(c: Customer, today: Date, anchorIso?: string | null): number | null {
  if (!c.onboard_date) return null;
  const { fu1Due, fu2Due } = followUpDueDates(anchorIso ?? c.onboard_date);
  const mid = new Date(today); mid.setHours(0, 0, 0, 0);
  const dayDiff = (d: Date) => Math.round((d.getTime() - mid.getTime()) / 86_400_000);
  if (!c.fu1_status) return dayDiff(fu1Due);
  if (!c.fu2_status) return dayDiff(fu2Due);
  return null;
}

/** The set of Follow-Ups directory status keys a customer belongs to. Pure. */
export function computeCustomerStatuses(
  c: Customer, ctx: CustomerStatusContext, today: Date = new Date(),
): Set<FollowUpStatusKey> {
  const s = new Set<FollowUpStatusKey>();
  const anchor = effectiveFollowUpAnchor(c, ctx);
  const fu = computeFuState(c, today, anchor);

  // A diagnosis call (had or scheduled) SUPERSEDES the normal cadence: hold
  // FU1/FU2 and run a dedicated diagnosis follow-up due 14 days after the call.
  // Once that follow-up is stamped done the customer is resolved (no resume).
  const DIAG_FOLLOWUP_DAYS = 14;
  const activeDiag = ctx.diagnosisCalls.filter(d => d.startIso && !d.followupDoneAt);
  const hasAnyDiag = ctx.diagnosisCalls.length > 0;
  const midToday = new Date(today); midToday.setHours(0, 0, 0, 0);
  const latestActiveStart = activeDiag.map(d => d.startIso as string).sort().at(-1);
  const diagDue = latestActiveStart != null
    && midToday.getTime() >= new Date(latestActiveStart).getTime() + DIAG_FOLLOWUP_DAYS * 86_400_000;

  // Otherwise, a pending follow-up is put ON HOLD while the customer has an
  // unresolved issue — a queued replacement or ANY open ticket (any category).
  // Held customers never show as overdue (the hold branch below skips the
  // overdue/due markers).
  const openIssueTickets = ctx.openTickets.filter(t => isIssueTicket(t as { category: string }));
  // Any open ticket (any category) holds a pending follow-up — not just issue
  // tickets. openIssueTickets is still used below for the post-close follow-up.
  const blockingCondition = ctx.queuedReplacement || ctx.openTickets.length > 0;
  const pendingFu = !!c.onboard_date && fu !== 'complete' && fu !== 'unscheduled';

  if (hasAnyDiag) {
    if (activeDiag.length > 0) {
      if (diagDue) s.add('diag_followup_due');
      else s.add('fu_on_hold');
    }
    // all diagnosis follow-ups done → resolved: normal cadence stays suppressed
  } else if (pendingFu && blockingCondition) {
    s.add('fu_on_hold');
  } else {
    if (fu === 'overdue_fu1' || fu === 'overdue_fu2') s.add('overdue');
    if (fu === 'due_fu1' || fu === 'due_fu2') s.add('due_today');
    const dnext = daysToNextFu(c, today, anchor);
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

  // Ticket-specific follow-up: once all issue tickets are closed, a follow-up
  // falls due 14 days after the most-recent close (until marked done).
  if (openIssueTickets.length === 0) {
    const due = ticketFollowupDueDate(ctx.lastClosedTicket);
    if (due && midToday.getTime() >= due.getTime()) s.add('ticket_followup_due');
  }

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

/** Calendar marker for a post-close ticket follow-up. */
export type TicketFollowup = { customerId: string; customerName: string; ticketId: string; dueDate: string };

export function useFollowUpDirectory(today: Date = new Date()): {
  rows: DirectoryRow[];
  counts: Record<FollowUpStatusKey, number>;
  overdueCount: number;
  // Customers in the return/refund workflow — excluded from follow-up entirely.
  excludedCustomerIds: Set<string>;
  // Post-close ticket follow-up markers (for the calendar).
  ticketFollowups: TicketFollowup[];
  loading: boolean;
} {
  const { customers, loading: lc } = useCustomers();
  const { tickets, loading: lt } = useServiceTickets();
  const { replacements, loading: lr } = useQueuedReplacements();
  // Keys (email/name) for customers in the return/refund workflow (any return
  // or refund_approval of any status) — these are removed from follow-up.
  const [excludedKeys, setExcludedKeys] = useState<Set<string>>(new Set());
  const [awaitingOnboardingIds, setAwaitingOnboardingIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [{ data: returns }, { data: refunds }, { data: lifecycle }] = await Promise.all([
        supabase.from('returns').select('customer_email, customer_name'),
        supabase.from('refund_approvals').select('customer_email, customer_name'),
        supabase.from('customer_lifecycle').select('customer_id, onboarding_status'),
      ]);
      if (cancelled) return;
      const rk = new Set<string>();
      const addKeys = (rows: Array<{ customer_email: string | null; customer_name: string | null }> | null) => {
        for (const r of rows ?? []) {
          if (r?.customer_email) rk.add(`email:${r.customer_email.toLowerCase().trim()}`);
          if (r?.customer_name) rk.add(`name:${r.customer_name.toLowerCase().trim()}`);
        }
      };
      addKeys(returns as Array<{ customer_email: string | null; customer_name: string | null }> | null);
      addKeys(refunds as Array<{ customer_email: string | null; customer_name: string | null }> | null);
      setExcludedKeys(rk);
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
    // Most-recent CLOSED ticket per customer (anchors the post-close follow-up).
    const lastClosedByCustomer = new Map<string, { id: string; closedAt: string | null; followupDoneAt: string | null }>();
    for (const t of tickets) {
      const cid = resolveCustomerId(t, idx);
      if (!cid) continue;
      if (t.status === 'closed') {
        if (!isIssueTicket(t)) continue; // onboarding/diagnosis don't anchor a post-close follow-up
        const prev = lastClosedByCustomer.get(cid);
        if (!prev || (t.closed_at ?? '') > (prev.closedAt ?? '')) {
          lastClosedByCustomer.set(cid, { id: t.id, closedAt: t.closed_at, followupDoneAt: t.post_close_followup_done_at });
        }
        continue;
      }
      const arr = ticketsByCustomer.get(cid);
      if (arr) arr.push(t); else ticketsByCustomer.set(cid, [t]);
    }
    // All diagnosis-call tickets (any status — diagnosis history matters), per customer.
    const diagnosisCallsByCustomer = new Map<string, { startIso: string | null; followupDoneAt: string | null }[]>();
    for (const t of tickets) {
      if (t.category !== 'diagnosis_call') continue;
      const cid = resolveCustomerId(t, idx);
      if (!cid) continue;
      const entry = { startIso: t.calendly_event_start, followupDoneAt: t.diagnosis_followup_done_at };
      const arr = diagnosisCallsByCustomer.get(cid);
      if (arr) arr.push(entry); else diagnosisCallsByCustomer.set(cid, [entry]);
    }
    const queuedIds = new Set<string>();
    for (const o of replacements) {
      const cid = resolveCustomerId(o as unknown as Matchable, idx);
      if (cid) queuedIds.add(cid);
    }
    // Customers in the return/refund workflow → excluded from follow-up entirely.
    const excludedCustomerIds = new Set<string>();
    for (const c of customers) {
      if (excludedKeys.has(`email:${(c.email ?? '').toLowerCase().trim()}`)
        || excludedKeys.has(`name:${(c.full_name ?? '').toLowerCase().trim()}`)) excludedCustomerIds.add(c.id);
    }

    const counts = Object.fromEntries(STATUS_FILTERS.map(f => [f.key, 0])) as Record<FollowUpStatusKey, number>;
    const ticketFollowups: TicketFollowup[] = [];
    const rows: DirectoryRow[] = [];
    for (const c of customers) {
      if (excludedCustomerIds.has(c.id)) continue; // removed from the follow-up workflow
      const openTickets = ticketsByCustomer.get(c.id) ?? [];
      const lastClosedTicket = lastClosedByCustomer.get(c.id) ?? null;
      const ctx: CustomerStatusContext = {
        openTickets,
        queuedReplacement: queuedIds.has(c.id),
        returned: false,
        awaitingOnboarding: awaitingOnboardingIds.has(c.id),
        diagnosisCalls: diagnosisCallsByCustomer.get(c.id) ?? [],
        lastClosedTicket,
      };
      const statuses = computeCustomerStatuses(c, ctx, today);
      // Fold in operator-applied manual tags (additive to the derived ones).
      for (const t of c.manual_status_tags ?? []) {
        if (STATUS_FILTERS.some(f => f.key === t)) statuses.add(t as FollowUpStatusKey);
      }
      for (const k of statuses) counts[k] += 1;
      rows.push({ customer: c, statuses, fuState: computeFuState(c, today) });

      // Calendar marker for the post-close ticket follow-up (close + 14d) —
      // only once the customer has no open issue tickets.
      if (openTickets.filter(t => isIssueTicket(t as { category: string })).length === 0) {
        const due = ticketFollowupDueDate(lastClosedTicket);
        if (due && lastClosedTicket) {
          ticketFollowups.push({ customerId: c.id, customerName: c.full_name, ticketId: lastClosedTicket.id, dueDate: due.toISOString() });
        }
      }
    }
    rows.sort((a, b) =>
      Number(b.statuses.has('overdue')) - Number(a.statuses.has('overdue'))
      || a.customer.full_name.localeCompare(b.customer.full_name));

    return { rows, counts, overdueCount: counts.overdue, excludedCustomerIds, ticketFollowups, loading: lc || lt || lr };
  }, [customers, tickets, replacements, excludedKeys, awaitingOnboardingIds, today, lc, lt, lr]);
}
