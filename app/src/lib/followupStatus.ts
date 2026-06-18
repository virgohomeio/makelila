import { computeFuState, FU1_DAYS, FU2_DAYS, type Customer } from './customers';
import type { ServiceTicket } from './service';

export type FollowUpStatusKey =
  | 'overdue' | 'due_today' | 'due_7d'
  | 'in_followup' | 'awaiting_onboarding' | 'awaiting_response'
  | 'awaiting_diagnosis' | 'queued_replacement' | 'on_hold'
  | 'awaiting_review' | 'active' | 'returned';

export const STATUS_FILTERS: { key: FollowUpStatusKey; label: string }[] = [
  { key: 'overdue',             label: 'Overdue' },
  { key: 'due_today',           label: 'Due today' },
  { key: 'due_7d',              label: 'Due in 7 days' },
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

  if (fu === 'overdue_fu1' || fu === 'overdue_fu2') s.add('overdue');
  if (fu === 'due_fu1' || fu === 'due_fu2') s.add('due_today');
  const dnext = daysToNextFu(c, today);
  if (dnext !== null && dnext > 0 && dnext <= 7) s.add('due_7d');

  if (c.onboard_date && fu !== 'complete' && fu !== 'unscheduled') s.add('in_followup');

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
