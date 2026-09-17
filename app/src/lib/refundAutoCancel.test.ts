// Mock fixtures pass `as any` to satisfy the polymorphic supabase client
// surface — this is the right escape valve for test mocks; the runtime
// behavior is what the tests assert.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { fromMock, logActionMock, cancelOrderMock, withdrawMock } = vi.hoisted(() => ({
  fromMock: vi.fn(),
  logActionMock: vi.fn(() => Promise.resolve()),
  cancelOrderMock: vi.fn((_orderId: string, _reason: string) => Promise.resolve()),
  withdrawMock: vi.fn((_orderId: string, _reason: string) => Promise.resolve(false)),
}));

vi.mock('./supabase', () => ({
  supabase: { from: fromMock, auth: { getSession: vi.fn(), getUser: vi.fn() }, rpc: vi.fn() },
  SUPABASE_URL: 'https://example.test',
  SUPABASE_ANON_KEY: 'anon',
}));
vi.mock('./activityLog', () => ({ logAction: logActionMock }));
vi.mock('./orders', () => ({ cancelOrder: cancelOrderMock }));
vi.mock('./fulfillment', () => ({ withdrawOrderFromQueue: withdrawMock }));

import {
  ordersToAutoCancel,
  cancelOpenOrdersForRefund,
  type AutoCancellableOrder,
} from './refundAutoCancel';

/** A live pending sale, the baseline every case below varies from. */
function sale(over: Partial<AutoCancellableOrder> = {}): AutoCancellableOrder {
  return {
    id: 'o1', order_ref: '#1231', kind: 'sale', status: 'pending',
    replacement_state: null, linked_ticket_id: null,
    shipped_at: null, delivered_at: null, tracking_num: null,
    ...over,
  };
}

function replacement(over: Partial<AutoCancellableOrder> = {}): AutoCancellableOrder {
  return sale({
    id: 'r1', order_ref: 'R-0048', kind: 'replacement',
    status: 'pending', replacement_state: 'ready', linked_ticket_id: 't1',
    ...over,
  });
}

const refs = (rows: AutoCancellableOrder[]) => rows.map(r => r.order_ref);

describe('ordersToAutoCancel', () => {
  it('takes every unshipped sale status the board can hold', () => {
    const rows = ['pending', 'flagged', 'held', 'approved'].map((status, i) =>
      sale({ id: `o${i}`, order_ref: `#12${i}`, status }));
    expect(refs(ordersToAutoCancel(rows, new Set()))).toEqual(['#120', '#121', '#122', '#123']);
  });

  it('leaves an already-cancelled order alone', () => {
    expect(ordersToAutoCancel([sale({ status: 'cancelled' })], new Set())).toEqual([]);
  });

  it('leaves a shipped or delivered sale alone', () => {
    expect(ordersToAutoCancel([sale({ shipped_at: '2026-08-01T00:00:00Z' })], new Set())).toEqual([]);
    expect(ordersToAutoCancel([sale({ delivered_at: '2026-08-04T00:00:00Z' })], new Set())).toEqual([]);
  });

  it('treats a tracking number as proof the box left, whatever shipped_at says', () => {
    // Per operator: tracking_num IS NOT NULL ⇒ shipped. Replacements in
    // particular almost never get shipped_at stamped.
    expect(ordersToAutoCancel([sale({ tracking_num: '1Z999' })], new Set())).toEqual([]);
    expect(ordersToAutoCancel([replacement({ tracking_num: '1Z999' })], new Set())).toEqual([]);
  });

  it('takes a live replacement in any state, including held', () => {
    const rows = (['ready', 'awaiting', 'held'] as const).map((st, i) =>
      replacement({ id: `r${i}`, order_ref: `R-004${i}`, replacement_state: st }));
    expect(refs(ordersToAutoCancel(rows, new Set()))).toEqual(['R-0040', 'R-0041', 'R-0042']);
  });

  it('leaves a replacement whose ticket is already done alone', () => {
    // shipped_at is almost never stamped on a replacement, so the linked
    // ticket is the real signal. Cancelling one of these would "release" a
    // unit that physically left the building months ago and restore parts
    // that were actually consumed.
    const rows = [replacement({ linked_ticket_id: 't-gone' })];
    expect(ordersToAutoCancel(rows, new Set(['t-gone']))).toEqual([]);
  });

  it('still takes a replacement whose ticket is open', () => {
    expect(refs(ordersToAutoCancel([replacement()], new Set(['t-other'])))).toEqual(['R-0048']);
  });

  it('ignores a sale status that is not a live one', () => {
    expect(ordersToAutoCancel([sale({ status: 'something_new' })], new Set())).toEqual([]);
  });

  it('leaves an order alone when a shipped unit is assigned to it', () => {
    // #1172 shipped on 2026-06-04 as LL01-00000000310 and the order row was
    // never stamped: no shipped_at, no tracking, still 'approved', with a
    // stale queue row. The unit is the only place that sale's history exists.
    const rows = [sale({ order_ref: '#1172', status: 'approved' })];
    expect(ordersToAutoCancel(rows, new Set(), { shippedOrderRefs: new Set(['#1172']) })).toEqual([]);
  });

  it('never returns the order the refund card is for', () => {
    // That order is the SUBJECT of the refund, not collateral. The card is
    // already its money-back record; cancelling it files a second one.
    const rows = [sale({ id: 'own', order_ref: '#1172' }), sale({ id: 'o2', order_ref: '#1233' })];
    expect(refs(ordersToAutoCancel(rows, new Set(), { excludeOrderId: 'own' }))).toEqual(['#1233']);
  });
});

/** A supabase double wide enough for the lookup half of the orchestrator. */
function harness(orders: AutoCancellableOrder[], goneTicketIds: string[] = [], shippedRefs: string[] = []) {
  const state = { emailFilter: null as string | null, ticketIdsAsked: [] as string[], unitRefsAsked: [] as string[] };
  fromMock.mockImplementation((table: string) => {
    if (table === 'orders') {
      return {
        select: () => ({
          ilike: (_c: string, email: string) => {
            state.emailFilter = email;
            return {
              neq: () => Promise.resolve({ data: orders, error: null }),
            };
          },
        }),
      } as any;
    }
    if (table === 'units') {
      return {
        select: () => ({
          in: (_c: string, refs: string[]) => {
            state.unitRefsAsked = refs;
            return Promise.resolve({
              data: shippedRefs
                .filter(r => refs.includes(r))
                .map(r => ({ customer_order_ref: r, status: 'shipped' })),
              error: null,
            });
          },
        }),
      } as any;
    }
    if (table === 'service_tickets') {
      return {
        select: () => ({
          in: (_c: string, ids: string[]) => {
            state.ticketIdsAsked = ids;
            return Promise.resolve({
              data: ids.map(id => ({
                id,
                status: goneTicketIds.includes(id) ? 'closed' : 'in_progress',
              })),
              error: null,
            });
          },
        }),
      } as any;
    }
    return {} as any;
  });
  return state;
}

describe('cancelOpenOrdersForRefund', () => {
  beforeEach(() => {
    fromMock.mockReset();
    logActionMock.mockClear();
    cancelOrderMock.mockReset();
    cancelOrderMock.mockResolvedValue(undefined);
    withdrawMock.mockReset();
    withdrawMock.mockResolvedValue(false);
  });

  it('cancels every live sale and replacement the customer has', async () => {
    harness([sale(), replacement()]);

    const out = await cancelOpenOrdersForRefund({
      refundId: 'refund-1',
      customerEmail: '  Jane@Example.COM ',
      customerName: 'Jane Doe',
    });

    expect(out.cancelled.map(c => c.order_ref)).toEqual(['#1231', 'R-0048']);
    expect(out.failed).toEqual([]);
    expect(cancelOrderMock).toHaveBeenCalledTimes(2);
    // The reason lands on the order and in Sales › Cancelled, so it has to say
    // why to someone who never saw the refund card.
    expect(cancelOrderMock.mock.calls[0][1]).toContain('refund');
  });

  it('pulls each order out of the fulfillment queue before cancelling it', async () => {
    harness([sale()]);
    withdrawMock.mockResolvedValue(true);
    const order: string[] = [];
    withdrawMock.mockImplementation(() => { order.push('withdraw'); return Promise.resolve(true); });
    cancelOrderMock.mockImplementation(() => { order.push('cancel'); return Promise.resolve(); });

    const out = await cancelOpenOrdersForRefund({
      refundId: 'refund-1', customerEmail: 'jane@example.com', customerName: 'Jane Doe',
    });

    // Queue first: cancelOrder does nothing queue-side, so the row (and the
    // machine reserved for it) would otherwise be left pointing at a cancelled
    // order and still be pickable.
    expect(order).toEqual(['withdraw', 'cancel']);
    expect(out.cancelled[0].wasQueued).toBe(true);
  });

  it('matches the customer on email, case- and whitespace-insensitively', async () => {
    const state = harness([sale()]);
    await cancelOpenOrdersForRefund({
      refundId: 'refund-1', customerEmail: '  Jane@Example.COM ', customerName: 'Jane Doe',
    });
    expect(state.emailFilter).toBe('jane@example.com');
  });

  it('does nothing at all when the card carries no email', async () => {
    harness([sale()]);
    const out = await cancelOpenOrdersForRefund({
      refundId: 'refund-1', customerEmail: null, customerName: 'Jane Doe',
    });
    expect(out.cancelled).toEqual([]);
    expect(out.skippedNoEmail).toBe(true);
    expect(cancelOrderMock).not.toHaveBeenCalled();
  });

  it('keeps going when one order refuses to cancel', async () => {
    harness([sale(), sale({ id: 'o2', order_ref: '#1232' })]);
    cancelOrderMock.mockRejectedValueOnce(new Error('no permission'));

    const out = await cancelOpenOrdersForRefund({
      refundId: 'refund-1', customerEmail: 'jane@example.com', customerName: 'Jane Doe',
    });

    expect(out.failed).toEqual([{ order_ref: '#1231', message: 'no permission' }]);
    expect(out.cancelled.map(c => c.order_ref)).toEqual(['#1232']);
  });

  it('asks about the linked tickets it actually saw, and skips finished ones', async () => {
    const state = harness(
      [replacement({ linked_ticket_id: 't-closed' }), replacement({ id: 'r2', order_ref: 'R-0049', linked_ticket_id: 't-open' })],
      ['t-closed'],
    );

    const out = await cancelOpenOrdersForRefund({
      refundId: 'refund-1', customerEmail: 'jane@example.com', customerName: 'Jane Doe',
    });

    expect(state.ticketIdsAsked.sort()).toEqual(['t-closed', 't-open']);
    expect(out.cancelled.map(c => c.order_ref)).toEqual(['R-0049']);
  });


  it('takes the card\'s own order out of the queue without cancelling it', async () => {
    harness([sale({ id: 'own', order_ref: '#1172' })]);
    withdrawMock.mockResolvedValue(true);

    const out = await cancelOpenOrdersForRefund({
      refundId: 'refund-1', customerEmail: 'jane@example.com', customerName: 'Jane Doe',
      refundOrderId: 'own',
    });

    // Nothing ships to a customer being paid back — but the refund card is
    // already the record for THIS order, so no cancel and no second
    // order_cancellations request for the same money.
    expect(withdrawMock).toHaveBeenCalledWith('own', expect.stringContaining('refund'));
    expect(cancelOrderMock).not.toHaveBeenCalled();
    expect(out.cancelled).toEqual([]);
    expect(out.withdrewOwnOrder).toBe('#1172');
  });

  it('leaves the customer\'s other orders cancellable alongside its own', async () => {
    harness([sale({ id: 'own', order_ref: '#1172' }), sale({ id: 'o2', order_ref: '#1233' })]);

    const out = await cancelOpenOrdersForRefund({
      refundId: 'refund-1', customerEmail: 'jane@example.com', customerName: 'Jane Doe',
      refundOrderId: 'own',
    });

    expect(out.cancelled.map(c => c.order_ref)).toEqual(['#1233']);
    expect(cancelOrderMock).toHaveBeenCalledTimes(1);
    expect(cancelOrderMock.mock.calls[0][0]).toBe('o2');
  });

  it('treats an order with a shipped unit against it as already gone', async () => {
    // The Amanda Acker case: order row says 'approved' with no shipped_at and
    // no tracking, and the machine went out in June.
    const state = harness([sale({ order_ref: '#1172', status: 'approved' })], [], ['#1172']);

    const out = await cancelOpenOrdersForRefund({
      refundId: 'refund-1', customerEmail: 'jane@example.com', customerName: 'Jane Doe',
    });

    expect(state.unitRefsAsked).toEqual(['#1172']);
    expect(out.cancelled).toEqual([]);
    expect(cancelOrderMock).not.toHaveBeenCalled();
    expect(withdrawMock).not.toHaveBeenCalled();
  });

  it('does not withdraw its own order when that order already shipped', async () => {
    harness([sale({ id: 'own', order_ref: '#1172', status: 'approved' })], [], ['#1172']);

    const out = await cancelOpenOrdersForRefund({
      refundId: 'refund-1', customerEmail: 'jane@example.com', customerName: 'Jane Doe',
      refundOrderId: 'own',
    });

    // A stale queue row on a shipped order is history, not a pick list — see
    // the fulfillment queue never auto-closing. Deleting it loses the record.
    expect(withdrawMock).not.toHaveBeenCalled();
    expect(out.withdrewOwnOrder).toBeNull();
  });

  it('records what it did on the activity log', async () => {
    harness([sale(), replacement()]);
    await cancelOpenOrdersForRefund({
      refundId: 'refund-1', customerEmail: 'jane@example.com', customerName: 'Jane Doe',
    });
    expect(logActionMock).toHaveBeenCalledWith(
      'refund_auto_cancelled', 'refund-1', expect.stringContaining('#1231'),
    );
  });

  it('writes no log line when the customer had nothing open', async () => {
    harness([]);
    const out = await cancelOpenOrdersForRefund({
      refundId: 'refund-1', customerEmail: 'jane@example.com', customerName: 'Jane Doe',
    });
    expect(out.cancelled).toEqual([]);
    expect(logActionMock).not.toHaveBeenCalled();
  });
});
