// The ship SLA, counted from the moment Sales confirms an order.
//
//   confirm day + 1  — the pickup must be BOOKED by end of day ("Pickup scheduled").
//   confirm day + 2  — the carrier must have PICKED IT UP by end of day.
//
// Set by the operator 2026-11-26, replacing the old 7-day queue due date and the
// placed-date + 2 pill. auto_enqueue_approved_order writes due_date = confirm
// day + 1 for new rows; the UI recomputes both deadlines from the confirm time
// so rows queued before the change read the same way.

export const SCHEDULE_PICKUP_DAYS = 1;
export const PICKED_UP_DAYS = 2;

export type DeadlineStage = 'schedule' | 'pickup';
export type DeadlineSeverity = 'ok' | 'soon' | 'today' | 'overdue';

export type ShipDeadlines = {
  confirmedAt: Date;
  scheduleBy: Date;
  pickupBy: Date;
};

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

/** When was this order confirmed? The later of the queue row's birth and the
 *  order's last disposition — a flagged-then-reconfirmed order restarts the
 *  clock at the reconfirm, and a replacement (no Sales confirm) starts when it
 *  was queued. */
export function confirmedAtOf(
  row: { created_at: string },
  order?: { status?: string | null; dispositioned_at?: string | null } | null,
): Date {
  const queued = new Date(row.created_at);
  const disp = order?.status === 'approved' && order.dispositioned_at
    ? new Date(order.dispositioned_at)
    : null;
  return disp && !Number.isNaN(disp.getTime()) && disp > queued ? disp : queued;
}

export function shipDeadlines(confirmedAt: Date): ShipDeadlines {
  const day = startOfDay(confirmedAt);
  return {
    confirmedAt,
    scheduleBy: addDays(day, SCHEDULE_PICKUP_DAYS),
    pickupBy: addDays(day, PICKED_UP_DAYS),
  };
}

/** Which deadline is live for a row at this step. Up to step 3 the pickup still
 *  has to be booked; at steps 4–5 it is booked and waiting on the carrier. */
export function stageForStep(step: number): DeadlineStage {
  return step <= 3 ? 'schedule' : 'pickup';
}

/** Whole calendar days from today to `due` (negative = overdue). */
export function daysUntil(due: Date, now: Date = new Date()): number {
  return Math.round((startOfDay(due).getTime() - startOfDay(now).getTime()) / 86_400_000);
}

export function severityOf(days: number): DeadlineSeverity {
  if (days < 0) return 'overdue';
  if (days === 0) return 'today';
  if (days === 1) return 'soon';
  return 'ok';
}

const STAGE_VERB: Record<DeadlineStage, string> = {
  schedule: 'Book pickup',
  pickup: 'Picked up',
};

/** "Book pickup today", "Picked up by tomorrow", "Book pickup · 2d late". */
export function deadlineLabel(stage: DeadlineStage, due: Date, now: Date = new Date()): string {
  const days = daysUntil(due, now);
  const verb = STAGE_VERB[stage];
  if (days < 0) return `${verb} · ${Math.abs(days)}d late`;
  if (days === 0) return `${verb} today`;
  if (days === 1) return `${verb} by tomorrow`;
  return `${verb} by ${due.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
}

export function shortDate(d: Date): string {
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}
