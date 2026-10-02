// Why this file exists: prod, 2026-09-10 18:49. Order #1252 (jennifer
// christine) sat at step 5 and the operator pressed "← Back" four times in
// thirty seconds. All four writes landed — the activity log holds four
// identical "Step 5 → 4" entries and the row really did end at step 4 — but
// the header never moved off step 5, so from the operator's side the order
// simply would not go backwards.
//
// The queue board reads its rows once and then relies entirely on the realtime
// socket for every later change. When that socket is dropped, the cache is
// frozen: the step never visibly moves, `row.step` stays 5, and each further
// click re-sends the same 5→4 rewind. Same shape as the refund board bug of
// 2026-08-13 (one card approved three times, the column never moving), so it
// gets the same cure — re-read on rejoin, plus a refresh the caller can pull
// after a mutation so a dead socket can't strand the board at all.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

const { orderMock, channelMock, removeChannelMock, subscribeCbs } = vi.hoisted(() => {
  const orderMock = vi.fn();
  const subscribeCbs: ((status: string) => void)[] = [];
  const channelMock = vi.fn(() => {
    const ch = {
      on: vi.fn(() => ch),
      subscribe: vi.fn((cb?: (status: string) => void) => {
        if (cb) { subscribeCbs.push(cb); cb('SUBSCRIBED'); }
        return ch;
      }),
    };
    return ch;
  });
  const removeChannelMock = vi.fn();
  return { orderMock, channelMock, removeChannelMock, subscribeCbs };
});

vi.mock('./supabase', () => ({
  supabase: {
    from: vi.fn(() => ({ select: vi.fn(() => ({ order: orderMock })) })),
    channel: channelMock,
    removeChannel: removeChannelMock,
    auth: { getUser: vi.fn(() => Promise.resolve({ data: { user: { id: 'u-1' } } })) },
  },
}));
vi.mock('./activityLog', () => ({ logAction: vi.fn(() => Promise.resolve()) }));

import { useFulfillmentQueue } from './fulfillment';

const rowAt = (step: number) => [{
  id: 'q-1252', order_id: 'o-1252', step, assigned_serial: 'LL01-00000000305',
  due_date: '2026-09-10', priority: false,
}];

beforeEach(() => {
  orderMock.mockReset();
  channelMock.mockClear();
  removeChannelMock.mockClear();
  subscribeCbs.length = 0;
});

describe('useFulfillmentQueue staleness', () => {
  it('re-reads when the realtime channel rejoins, so a dropped socket heals', async () => {
    // First read sees step 5. While the socket is down the row is rewound to 4.
    orderMock
      .mockResolvedValueOnce({ data: rowAt(5), error: null })
      .mockResolvedValue({ data: rowAt(4), error: null });

    const { result } = renderHook(() => useFulfillmentQueue());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.ready[0].step).toBe(5);

    // The initial join must NOT trigger a second read — the fetch above is current.
    expect(orderMock).toHaveBeenCalledTimes(1);

    // Socket drops and rejoins. Every change made in the gap has to be re-read.
    await act(async () => { subscribeCbs[0]('SUBSCRIBED'); });
    await waitFor(() => expect(result.current.ready[0].step).toBe(4));
  });

  it('exposes a refresh the board can pull after a mutation', async () => {
    orderMock
      .mockResolvedValueOnce({ data: rowAt(5), error: null })
      .mockResolvedValue({ data: rowAt(4), error: null });

    const { result } = renderHook(() => useFulfillmentQueue());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.ready[0].step).toBe(5);

    await act(async () => { await result.current.refresh(); });
    expect(result.current.ready[0].step).toBe(4);
  });

  it('tears the channel down with removeChannel, not unsubscribe', async () => {
    orderMock.mockResolvedValue({ data: rowAt(5), error: null });
    const { result, unmount } = renderHook(() => useFulfillmentQueue());
    await waitFor(() => expect(result.current.loading).toBe(false));
    unmount();
    expect(removeChannelMock).toHaveBeenCalled();
  });
});
