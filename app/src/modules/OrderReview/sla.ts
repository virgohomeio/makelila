// The confirm SLA, and where a given order sits on a shared scale.
//
// Sales' spine is age, exactly as Support Tickets' is: an order is confirmed
// within 2 days of being placed, 4 at the outside. But age rendered as a bare
// "6d" chip has no reference point, so 3d and 11d read as equally "late".
//
// This is the Sales counterpart of Service/dwell.ts. The rail plots every row
// against one axis whose ticks are drawn once in the list header, so scanning
// the column shows the shape of the queue rather than a list of unrelated
// numbers.
//
// Pure — no dates resolved here, no DOM. The caller passes `now` so the value
// is stable across a render and trivially testable.

export type SlaTier = 'ontime' | 'due' | 'late';

/** Days after placement within which an order should be confirmed. Also the
 *  reference line drawn on every rail. */
export const SLA_DAYS = 2;
/** Days after placement past which an order is simply late. */
export const OVERDUE_DAYS = 4;

const MS_PER_DAY = 86_400_000;

/** Whole days between `iso` and `now`. A timestamp in the future — which clock
 *  skew on a synced Shopify row can produce — clamps to 0. */
export function daysSincePlaced(iso: string | null | undefined, now: number): number {
  if (!iso) return 0;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.floor((now - t) / MS_PER_DAY));
}

export function slaTier(days: number): SlaTier {
  if (days <= SLA_DAYS) return 'ontime';
  if (days <= OVERDUE_DAYS) return 'due';
  return 'late';
}

// Anchors for the rail's scale, as [days, percent] pairs. Deliberately not
// linear: all the resolution that matters is inside the first week, and
// everything past a fortnight is equally bad, so the tail compresses. The tick
// labels in the list header are drawn from these same anchors.
const ANCHORS: ReadonlyArray<readonly [number, number]> = [
  [0, 0], [SLA_DAYS, 30], [OVERDUE_DAYS, 55], [7, 78], [14, 100],
];

/** Ticks for the list header, so the axis and the marks cannot drift. */
export const SLA_TICKS: ReadonlyArray<{ label: string; pct: number }> = [
  { label: 'today', pct: 0 },
  { label: '2d', pct: 30 },
  { label: '4d', pct: 55 },
  { label: '1w', pct: 78 },
  { label: '2w+', pct: 100 },
];

/** Where a given age sits on the rail, 0–100. */
export function slaPercent(days: number): number {
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

/** Compact age label. Days up to a fortnight, then weeks — a queue measured in
 *  "23d" reads as noise; "3w" reads as a problem. */
export function slaLabel(days: number): string {
  if (days < 1) return 'today';
  if (days <= 14) return `${days}d`;
  return `${Math.round(days / 7)}w`;
}
