// Why this file exists: prod, 2026-09-11. Amanda Acker (return 381fef63, ticket
// ST-2026-0418) showed on Returns as queued for a P100X replacement — eleven
// days after R-0051 was cancelled with the reason "She is queued for
// return/refund". The row is still in `orders`: cancelling a replacement keeps
// it and only flips `status`, leaving `replacement_state` at its last value.
//
// Every other replacement lookup in orders.ts pairs its state filter with
// `.neq('status','cancelled')`. useQueuedReplacements — the one that feeds the
// Returns/Refunds "hold this replacement before refunding" warning and the
// Follow-Ups directory — did not, so a cancelled replacement kept warning
// operators off a refund that was the whole reason it was cancelled.
//
// Mock fixtures pass `as any` to satisfy the polymorphic supabase client
// surface — the runtime behavior is what the tests assert.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

const { fromMock, channelMock, calls, handlers } = vi.hoisted(() => {
  const calls: Array<{ table: string; method: string; args: unknown[] }> = [];
  const handlers: Array<(p: any) => void> = [];
  const fromMock = vi.fn();
  const channelMock = vi.fn(() => {
    const ch: any = {
      on: vi.fn((_e: unknown, _f: unknown, cb: (p: any) => void) => { handlers.push(cb); return ch; }),
      subscribe: vi.fn(() => ch),
      unsubscribe: vi.fn(),
    };
    return ch;
  });
  return { fromMock, channelMock, calls, handlers };
});

vi.mock('./supabase', () => ({
  supabase: {
    from: fromMock,
    channel: channelMock,
    auth: { getUser: vi.fn(() => Promise.resolve({ data: { user: { id: 'u-1' } } })) },
  },
}));
vi.mock('./activityLog', () => ({ logAction: vi.fn(() => Promise.resolve()) }));

import { useQueuedReplacements } from './orders';

/** A chainable, thenable query builder that records every filter applied. */
function builder(table: string, result: unknown) {
  const ch: any = {};
  for (const m of ['select', 'eq', 'neq', 'in', 'is', 'order', 'not']) {
    ch[m] = vi.fn((...args: unknown[]) => { calls.push({ table, method: m, args }); return ch; });
  }
  ch.then = (res: (v: unknown) => unknown) => Promise.resolve(result).then(res);
  return ch;
}

const cancelledR0051 = {
  id: 'o-r0051', order_ref: 'R-0051', kind: 'replacement', status: 'cancelled',
  replacement_state: 'awaiting', shipped_at: null, linked_ticket_id: 't-0418',
  customer_name: 'Amanda Acker', awaiting_batch_id: 'P100X',
};
const liveR0062 = {
  id: 'o-r0062', order_ref: 'R-0062', kind: 'replacement', status: 'flagged',
  replacement_state: 'awaiting', shipped_at: null, linked_ticket_id: 't-0500',
  customer_name: 'Sharon Corcoran', awaiting_batch_id: 'P100X',
};

/** What the server returns once the filters the hook asked for are honoured. */
function serve(rows: unknown[]) {
  fromMock.mockImplementation((table: string) => {
    if (table === 'service_tickets') return builder(table, { data: [], error: null });
    const applied = calls.filter(c => c.table === 'orders');
    const excludesCancelled = () => calls.some(c =>
      c.table === 'orders' && c.method === 'neq' && c.args[0] === 'status' && c.args[1] === 'cancelled');
    void applied;
    return builder(table, {
      get data() {
        return excludesCancelled()
          ? rows.filter((r: any) => r.status !== 'cancelled')
          : rows;
      },
      error: null,
    });
  });
}

beforeEach(() => {
  calls.length = 0;
  handlers.length = 0;
  fromMock.mockReset();
  channelMock.mockClear();
});

describe('useQueuedReplacements', () => {
  it('excludes a cancelled replacement from the queued list', async () => {
    serve([cancelledR0051, liveR0062]);
    const { result } = renderHook(() => useQueuedReplacements());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.replacements.map(r => r.order_ref)).toEqual(['R-0062']);
  });

  it('asks the server to exclude cancelled rows rather than filtering after the fact', async () => {
    serve([liveR0062]);
    const { result } = renderHook(() => useQueuedReplacements());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(calls).toContainEqual(
      expect.objectContaining({ table: 'orders', method: 'neq', args: ['status', 'cancelled'] }),
    );
  });

  it('drops a row from the live list the moment it is cancelled', async () => {
    serve([liveR0062]);
    const { result } = renderHook(() => useQueuedReplacements());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.replacements).toHaveLength(1);

    act(() => {
      handlers.forEach(h => h({
        eventType: 'UPDATE',
        new: { ...liveR0062, status: 'cancelled' },
      }));
    });

    expect(result.current.replacements).toHaveLength(0);
  });

  it('still lists a live replacement arriving over realtime', async () => {
    serve([]);
    const { result } = renderHook(() => useQueuedReplacements());
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      handlers.forEach(h => h({ eventType: 'INSERT', new: liveR0062 }));
    });

    expect(result.current.replacements.map(r => r.order_ref)).toEqual(['R-0062']);
  });
});
