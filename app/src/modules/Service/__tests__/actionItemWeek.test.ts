import { describe, it, expect } from 'vitest';
import type { TicketActionItem } from '../../../lib/service';
import {
  toDateKey, fromDateKey, weekStartKey, weekDayKeys, dayColumnLabel,
  buildActionItemBoard, dropTarget,
} from '../actionItemWeek';

const item = (id: string, due: string | null, extra: Partial<TicketActionItem> = {}) => ({
  id, ticket_id: 't1', body: `do ${id}`, done: false,
  done_at: null, done_by: null, author_id: null, author_email: null,
  created_at: '2026-08-01T00:00:00Z', due_date: due, ...extra,
}) as TicketActionItem;

// Tuesday 2026-08-11. Its week runs Mon 2026-08-10 … Sun 2026-08-16.
const TUE = new Date(2026, 7, 11);
const WEEK = weekDayKeys(weekStartKey(TUE));
const TODAY = '2026-08-11';

describe('date keys', () => {
  it('uses the LOCAL day, not the UTC day', () => {
    // 11pm local on the 11th is already the 12th in UTC. toISOString() would
    // return the wrong day here; toDateKey must not.
    expect(toDateKey(new Date(2026, 7, 11, 23, 30))).toBe('2026-08-11');
    expect(toDateKey(new Date(2026, 7, 11, 0, 30))).toBe('2026-08-11');
  });

  it('round-trips through fromDateKey at local midnight', () => {
    const d = fromDateKey('2026-08-11');
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(7);
    expect(d.getDate()).toBe(11);
    expect(toDateKey(d)).toBe('2026-08-11');
  });
});

describe('weekStartKey', () => {
  it('finds the Monday of a midweek day', () => {
    expect(weekStartKey(new Date(2026, 7, 11))).toBe('2026-08-10'); // Tue -> Mon
  });

  it('treats Monday as its own week start', () => {
    expect(weekStartKey(new Date(2026, 7, 10))).toBe('2026-08-10');
  });

  it('puts Sunday in the week that started the previous Monday', () => {
    expect(weekStartKey(new Date(2026, 7, 16))).toBe('2026-08-10'); // Sun
  });

  it('shifts whole weeks with the offset', () => {
    expect(weekStartKey(TUE, 1)).toBe('2026-08-17');
    expect(weekStartKey(TUE, -1)).toBe('2026-08-03');
  });

  it('crosses a month boundary correctly', () => {
    expect(weekStartKey(new Date(2026, 8, 2))).toBe('2026-08-31'); // Wed Sep 2
  });
});

describe('weekDayKeys', () => {
  it('returns seven consecutive days Mon..Sun', () => {
    expect(WEEK).toEqual([
      '2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13',
      '2026-08-14', '2026-08-15', '2026-08-16',
    ]);
  });

  it('labels days as weekday + date', () => {
    expect(dayColumnLabel('2026-08-10')).toBe('Mon 10');
    expect(dayColumnLabel('2026-08-16')).toBe('Sun 16');
  });
});

describe('buildActionItemBoard', () => {
  it('lays out Overdue, seven days, then No due date', () => {
    const { columns } = buildActionItemBoard([], WEEK, TODAY);
    expect(columns).toHaveLength(9);
    expect(columns[0].key).toBe('overdue');
    expect(columns[8].key).toBe('nodate');
    expect(columns.slice(1, 8).map(c => c.kind)).toEqual(Array(7).fill('day'));
  });

  it('buckets by due date', () => {
    const { columns } = buildActionItemBoard(
      [item('a', '2026-08-12'), item('b', '2026-08-12'), item('c', '2026-08-14')],
      WEEK, TODAY,
    );
    const byKey = Object.fromEntries(columns.map(c => [c.key, c.items.map(i => i.id)]));
    expect(byKey['2026-08-12']).toEqual(['a', 'b']);
    expect(byKey['2026-08-14']).toEqual(['c']);
    expect(byKey['2026-08-13']).toEqual([]);
  });

  it('sends items dated before today to Overdue, even inside the visible week', () => {
    // Mon the 10th is in the visible week but already past.
    const { columns } = buildActionItemBoard([item('late', '2026-08-10')], WEEK, TODAY);
    expect(columns[0].items.map(i => i.id)).toEqual(['late']);
    expect(columns.find(c => c.key === '2026-08-10')!.items).toEqual([]);
  });

  it('treats today as due, not overdue', () => {
    const { columns } = buildActionItemBoard([item('now', TODAY)], WEEK, TODAY);
    expect(columns[0].items).toEqual([]);
    expect(columns.find(c => c.key === TODAY)!.items.map(i => i.id)).toEqual(['now']);
  });

  it('pools undated items under No due date', () => {
    const { columns } = buildActionItemBoard([item('someday', null)], WEEK, TODAY);
    expect(columns[8].items.map(i => i.id)).toEqual(['someday']);
  });

  it('counts future items outside the week instead of hiding them silently', () => {
    const board = buildActionItemBoard(
      [item('far', '2026-09-30'), item('near', '2026-08-12')], WEEK, TODAY,
    );
    expect(board.beyondWeekCount).toBe(1);
    expect(board.columns.flatMap(c => c.items).map(i => i.id)).toEqual(['near']);
  });

  it('marks the today column and only that one', () => {
    const { columns } = buildActionItemBoard([], WEEK, TODAY);
    expect(columns.filter(c => c.isToday).map(c => c.key)).toEqual([TODAY]);
  });

  it('excludes done items', () => {
    const { columns } = buildActionItemBoard(
      [item('x', TODAY, { done: true }), item('y', TODAY)], WEEK, TODAY,
    );
    expect(columns.find(c => c.key === TODAY)!.items.map(i => i.id)).toEqual(['y']);
  });

  it('orders a column oldest-created first', () => {
    const { columns } = buildActionItemBoard([
      item('new', TODAY, { created_at: '2026-08-05T00:00:00Z' }),
      item('old', TODAY, { created_at: '2026-08-01T00:00:00Z' }),
    ], WEEK, TODAY);
    expect(columns.find(c => c.key === TODAY)!.items.map(i => i.id)).toEqual(['old', 'new']);
  });

  it('orders Overdue by how overdue it is', () => {
    const { columns } = buildActionItemBoard(
      [item('recent', '2026-08-09'), item('ancient', '2026-07-01')], WEEK, TODAY,
    );
    expect(columns[0].items.map(i => i.id)).toEqual(['ancient', 'recent']);
  });

  it('shows overdue while paging to a future week', () => {
    const nextWeek = weekDayKeys(weekStartKey(TUE, 1));
    const board = buildActionItemBoard([item('late', '2026-08-01')], nextWeek, TODAY);
    expect(board.columns[0].items.map(i => i.id)).toEqual(['late']);
    // This week's items are neither overdue nor in next week's columns.
    const b2 = buildActionItemBoard([item('soon', '2026-08-12')], nextWeek, TODAY);
    expect(b2.beyondWeekCount).toBe(1);
  });
});

describe('dropTarget', () => {
  const cols = buildActionItemBoard([], WEEK, TODAY).columns;

  it('schedules to the column day', () => {
    expect(dropTarget(cols.find(c => c.key === '2026-08-13')!)).toEqual({ due: '2026-08-13' });
  });

  it('clears the date on the No-due-date column', () => {
    expect(dropTarget(cols[8])).toEqual({ due: null });
  });

  it('rejects a drop on Overdue — you cannot schedule into the past', () => {
    expect(dropTarget(cols[0])).toBe('reject');
  });
});
