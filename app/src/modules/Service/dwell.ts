// Dwell — how long a ticket has sat untouched, and where that sits on a shared
// scale.
//
// Why this exists: 152 of the 227 open support tickets have had no activity in
// over a month (measured 2026-08-19). Age is the variable that actually
// separates them from each other, but it rendered as a bare "68d" cell with no
// reference point, so two rows reading 41d and 98d looked equally like "old".
//
// The rail plots every row against one axis whose ticks are drawn in the column
// header, so scanning the column shows the shape of the backlog rather than a
// list of unrelated numbers.
//
// Pure — no dates resolved here, no DOM. The caller passes `now` so the value
// is stable across a render and trivially testable.

export type DwellTier = 'fresh' | 'mid' | 'stale';

/** Days without activity below which a ticket is not yet a concern. */
export const FRESH_DAYS = 7;
/** Days without activity past which a ticket counts as stale. Also the
 *  reference line drawn on the rail — the threshold most of the queue has
 *  crossed. */
export const STALE_DAYS = 30;

const MS_PER_DAY = 86_400_000;

/** Whole days between `iso` and `now`. Negative inputs (a timestamp in the
 *  future, which clock skew on a synced row can produce) clamp to 0. */
export function daysIdle(iso: string | null | undefined, now: number): number {
  if (!iso) return 0;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.floor((now - t) / MS_PER_DAY));
}

export function dwellTier(days: number): DwellTier {
  if (days <= FRESH_DAYS) return 'fresh';
  if (days <= STALE_DAYS) return 'mid';
  return 'stale';
}

// Anchors for the rail's scale, as [days, percent] pairs. Deliberately not
// linear: the interesting resolution is in the first month, and everything past
// three months is equally bad, so the tail compresses. The tick labels in the
// table header are drawn from these same anchors.
const ANCHORS: ReadonlyArray<readonly [number, number]> = [
  [0, 0], [FRESH_DAYS, 25], [STALE_DAYS, 50], [60, 75], [90, 100],
];

/** Ticks for the column header, so the axis and the marks cannot drift. */
export const DWELL_TICKS: ReadonlyArray<{ label: string; pct: number }> = [
  { label: 'today', pct: 0 },
  { label: '1w', pct: 25 },
  { label: '1m', pct: 50 },
  { label: '2m', pct: 75 },
  { label: '3m+', pct: 100 },
];

/** Where a given age sits on the rail, 0–100. */
export function dwellPercent(days: number): number {
  if (days <= 0) return 0;
  const last = ANCHORS[ANCHORS.length - 1];
  if (days >= last[0]) return 100;
  for (let i = 1; i < ANCHORS.length; i++) {
    const [d1, p1] = ANCHORS[i];
    if (days <= d1) {
      const [d0, p0] = ANCHORS[i - 1];
      return p0 + ((days - d0) / (d1 - d0)) * (p1 - p0);
    }
  }
  return 100;
}

/** Compact age label. Days up to a month, then months — a queue measured in
 *  "68d" reads as noise; "2mo" reads as a problem. */
export function dwellLabel(days: number): string {
  if (days < 1) return 'today';
  if (days <= STALE_DAYS) return `${days}d`;
  return `${Math.round(days / 30.4)}mo`;
}
