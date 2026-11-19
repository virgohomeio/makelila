// Week-view bucketing for the action-item kanban.
//
// Everything here works on 'YYYY-MM-DD' calendar-day strings, never Date
// instants. `ticket_action_items.due_date` is a Postgres `date`, and the board
// answers "what is due Wednesday" — both are day-granular, so introducing a
// timestamp anywhere would let a due date drift across midnight depending on
// the viewer's timezone.
//
// Pure — no supabase import, no `new Date()` without an argument, so it is
// unit-testable and the caller controls "today".
import type { TicketActionItem } from '../../lib/service';

/** Local calendar day of a Date as 'YYYY-MM-DD'.
 *  Built from the local getters, NOT toISOString() — the latter converts to UTC
 *  and returns the wrong day for anyone west of Greenwich after ~5pm. */
export function toDateKey(d: Date): string {
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/** Parse 'YYYY-MM-DD' into a local-midnight Date. `new Date('2026-08-11')`
 *  parses as UTC midnight, which is the previous day in western timezones —
 *  hence the explicit component constructor. */
export function fromDateKey(key: string): Date {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** The Monday of the week containing `today`, shifted by `weekOffset` weeks. */
export function weekStartKey(today: Date, weekOffset = 0): string {
  const d = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  // getDay(): 0=Sun … 6=Sat. Monday-based, so Sunday belongs to the week before.
  const mondayDelta = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - mondayDelta + weekOffset * 7);
  return toDateKey(d);
}

/** The seven day-keys Mon…Sun starting at `startKey`. */
export function weekDayKeys(startKey: string): string[] {
  const start = fromDateKey(startKey);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    return toDateKey(d);
  });
}

const WEEKDAY = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** 'Mon 11' — the short column heading for a day. */
export function dayColumnLabel(key: string): string {
  const d = fromDateKey(key);
  return `${WEEKDAY[(d.getDay() + 6) % 7]} ${d.getDate()}`;
}

/** 'Aug 11 – Aug 17' — the range heading for the visible week. */
export function weekRangeLabel(dayKeys: string[]): string {
  if (dayKeys.length === 0) return '';
  const fmt = (k: string) =>
    fromDateKey(k).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `${fmt(dayKeys[0])} – ${fmt(dayKeys[dayKeys.length - 1])}`;
}

export type ColumnKind = 'overdue' | 'day' | 'nodate';

export type ActionItemColumn = {
  key: string;
  label: string;
  kind: ColumnKind;
  /** The day this column schedules to. null for Overdue (can't schedule into
   *  the past) and for No-due-date (drops there clear the date). */
  dateKey: string | null;
  /** True when this column is today — the board highlights it. */
  isToday: boolean;
  items: TicketActionItem[];
};

export type ActionItemBoard = {
  columns: ActionItemColumn[];
  /** Open items that are dated, not overdue, but fall outside the visible week.
   *  Surfaced as a count in the header so the board never silently hides work. */
  beyondWeekCount: number;
};

/** Oldest-first within a column: earliest due date, then earliest created. */
function byDueThenCreated(a: TicketActionItem, b: TicketActionItem): number {
  const d = (a.due_date ?? '').localeCompare(b.due_date ?? '');
  if (d !== 0) return d;
  return a.created_at.localeCompare(b.created_at);
}

/**
 * Bucket open action items into board columns.
 *
 * Overdue is relative to `todayKey`, not to the visible week, so it stays
 * meaningful (and pinned) while paging forward or back. Items dated outside the
 * visible week that aren't overdue belong to no column — they're counted in
 * `beyondWeekCount` rather than dropped silently.
 *
 * Done items are filtered defensively; the hook already scopes to done=false,
 * but an optimistic toggle can leave one in the array for a frame.
 */
export function buildActionItemBoard(
  items: TicketActionItem[],
  dayKeys: string[],
  todayKey: string,
): ActionItemBoard {
  const open = items.filter(i => !i.done);
  const dayIndex = new Set(dayKeys);

  const overdue: TicketActionItem[] = [];
  const noDate: TicketActionItem[] = [];
  const byDay = new Map<string, TicketActionItem[]>(dayKeys.map(k => [k, []]));
  let beyondWeekCount = 0;

  for (const item of open) {
    if (!item.due_date) { noDate.push(item); continue; }
    if (item.due_date < todayKey) { overdue.push(item); continue; }
    if (dayIndex.has(item.due_date)) { byDay.get(item.due_date)!.push(item); continue; }
    beyondWeekCount++;
  }

  const columns: ActionItemColumn[] = [
    {
      key: 'overdue', label: 'Overdue', kind: 'overdue',
      dateKey: null, isToday: false, items: overdue.sort(byDueThenCreated),
    },
    ...dayKeys.map((k): ActionItemColumn => ({
      key: k,
      label: dayColumnLabel(k),
      kind: 'day',
      dateKey: k,
      isToday: k === todayKey,
      items: (byDay.get(k) ?? []).sort(byDueThenCreated),
    })),
    {
      key: 'nodate', label: 'No due date', kind: 'nodate',
      dateKey: null, isToday: false, items: noDate.sort(byDueThenCreated),
    },
  ];

  return { columns, beyondWeekCount };
}

/** The due date a drop on this column should write, or 'reject' when the drop
 *  is meaningless (Overdue — you can't schedule work into the past). */
export function dropTarget(col: ActionItemColumn): { due: string | null } | 'reject' {
  if (col.kind === 'overdue') return 'reject';
  return { due: col.dateKey };
}
