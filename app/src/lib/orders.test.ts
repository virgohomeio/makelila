// Mock fixtures pass `as any` to satisfy the polymorphic supabase client
// surface — this is the right escape valve for test mocks; the runtime
// behavior is what the tests assert.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { updateMock, eqMock, fromMock, getUserMock, logActionMock, rpcMock } = vi.hoisted(() => {
  const updateMock = vi.fn();
  const eqMock = vi.fn();
  // All .from() calls in these tests go through 'orders'; logAction is fully mocked.
  const fromMock = vi.fn(() => ({ update: updateMock }));
  const getUserMock = vi.fn<() => Promise<{ data: { user: { id: string } | null } }>>(
    () => Promise.resolve({ data: { user: { id: 'user-1' } } }),
  );
  const logActionMock = vi.fn(() => Promise.resolve());
  const rpcMock = vi.fn();
  return { updateMock, eqMock, fromMock, getUserMock, logActionMock, rpcMock };
});

vi.mock('./supabase', () => ({
  supabase: {
    from: fromMock,
    auth: { getUser: getUserMock },
    rpc: rpcMock,
  },
}));
vi.mock('./activityLog', () => ({
  logAction: logActionMock,
}));

import { bucketOrders, type Order, disposition, needInfo, nextReplacementOrderRef, createReplacementOrder, createPendingReplacement, hasPendingLine, markOrderShipped, markOrderDelivered, cancelReplacementOrder } from './orders';

describe('disposition', () => {
  beforeEach(() => {
    updateMock.mockReset();
    eqMock.mockReset();
    updateMock.mockReturnValue({ eq: eqMock });
    eqMock.mockResolvedValue({ data: null, error: null });
    fromMock.mockClear();
    logActionMock.mockReset();
    logActionMock.mockResolvedValue(undefined);
  });

  it('updates status + timestamps and writes activity_log verb-form type', async () => {
    const testOrder = { id: 'order-1', order_ref: '#TEST-1', customer_name: 'Test Customer' };
    await disposition(testOrder, 'approved', 'Looks good');

    expect(fromMock).toHaveBeenCalledWith('orders');
    expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({
      status: 'approved',
      dispositioned_by: 'user-1',
    }));
    expect(eqMock).toHaveBeenCalledWith('id', 'order-1');
    expect(logActionMock).toHaveBeenCalledWith('order_approve', '#TEST-1', 'Looks good');
  });

  it.each([
    ['flagged' as const, 'order_flag'],
    ['held' as const,    'order_hold'],
  ])('maps %s → %s', async (status, type) => {
    const testOrder = { id: 'order-2', order_ref: '#T-2', customer_name: 'T' };
    await disposition(testOrder, status, 'reason');
    expect(logActionMock).toHaveBeenCalledWith(type, '#T-2', 'reason');
  });

  it('throws if unauthenticated', async () => {
    getUserMock.mockResolvedValueOnce({ data: { user: null } });
    const o = { id: 'order-3', order_ref: '#T-3', customer_name: 'T' };
    await expect(disposition(o, 'approved')).rejects.toThrow(/not authenticated/i);
  });

  it('surfaces the UPDATE error', async () => {
    eqMock.mockResolvedValueOnce({ data: null, error: new Error('RLS denied') });
    const o = { id: 'order-4', order_ref: '#T-4', customer_name: 'T' };
    await expect(disposition(o, 'approved')).rejects.toThrow(/RLS denied/);
    expect(logActionMock).not.toHaveBeenCalled();
  });

  it('falls back to customer_name when reason is omitted', async () => {
    const o = { id: 'order-5', order_ref: '#FB', customer_name: 'Fallback Customer' };
    await disposition(o, 'approved');
    expect(logActionMock).toHaveBeenCalledWith('order_approve', '#FB', 'Fallback Customer');
  });
});

describe('needInfo', () => {
  beforeEach(() => {
    updateMock.mockReset();
    logActionMock.mockReset();
    logActionMock.mockResolvedValue(undefined);
  });

  it('writes activity_log without changing status', async () => {
    const o = { id: 'order-1', order_ref: '#NI-1', customer_name: 'Ned' };
    await needInfo(o, 'Need a photo of the driveway');
    expect(updateMock).not.toHaveBeenCalled();
    expect(logActionMock).toHaveBeenCalledWith(
      'order_need_info',
      '#NI-1',
      'Need a photo of the driveway',
    );
  });
});

describe('nextReplacementOrderRef', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the value of the next_replacement_order_ref RPC', async () => {
    rpcMock.mockResolvedValueOnce({ data: 'R-0042', error: null });
    const ref = await nextReplacementOrderRef();
    expect(ref).toBe('R-0042');
    expect(rpcMock).toHaveBeenCalledWith('next_replacement_order_ref');
  });

  it('throws when the RPC errors', async () => {
    rpcMock.mockResolvedValueOnce({ data: null, error: { message: 'rpc failed' } });
    await expect(nextReplacementOrderRef()).rejects.toThrow('rpc failed');
  });
});

describe('createReplacementOrder', () => {
  beforeEach(() => vi.clearAllMocks());

  it('inserts an order with kind=replacement and computes COGS', async () => {
    // rpcMock handles both next_replacement_order_ref and decrement_part_on_hand
    rpcMock.mockImplementation((name: string) => {
      if (name === 'next_replacement_order_ref') return Promise.resolve({ data: 'R-0007', error: null });
      if (name === 'decrement_part_on_hand') return Promise.resolve({ data: 8, error: null });
      if (name === 'add_ticket_tag') return Promise.resolve({ data: null, error: null });
      return Promise.resolve({ data: null, error: { message: `unexpected rpc ${name}` } });
    });
    const insertSingle = vi.fn().mockResolvedValue({ data: { id: 'o1', order_ref: 'R-0007' }, error: null });
    const select = vi.fn().mockReturnValue({ single: insertSingle });
    const insert = vi.fn().mockReturnValue({ select });
    const ticketUpdate = vi.fn().mockResolvedValue({ error: null });
    const unitsUpdate = vi.fn().mockResolvedValue({ error: null });
    const queueInsert = vi.fn().mockResolvedValue({ error: null });

    fromMock.mockImplementation(((table: string) => {
      if (table === 'orders') return { insert };
      if (table === 'fulfillment_queue') return { insert: queueInsert };
      if (table === 'service_tickets') return { update: () => ({ eq: ticketUpdate }) };
      if (table === 'units') return {
        // createReplacementOrder now checks the unit isn't quarantined before reserving.
        select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: { status: 'ready' }, error: null }) }) }),
        update: () => ({ eq: unitsUpdate }),
      };
      throw new Error(`unexpected table ${table}`);
    }) as any);

    logActionMock.mockResolvedValue(undefined);

    const result = await createReplacementOrder({
      ticket_id: 't1',
      customer_name: 'Linda Smith',
      address: { address_line: '123 Maple', city: 'Toronto', region_state: 'ON',
                 country: 'CA', postal_code: 'M5J 2N8' },
      line_items: [
        { kind: 'part', part_id: 'p1', sku: 'HINGE-01', name: 'Lid Hinge', qty: 2, cost_per_unit_usd: 4.2 },
        { kind: 'unit', unit_serial: 'LL01-284', batch: 'B7', name: 'LILA Pro (B7 White)', qty: 1, cost_usd: 312 },
      ],
    });

    expect(result.order_ref).toBe('R-0007');
    const insertArg = insert.mock.calls[0][0];
    expect(insertArg.kind).toBe('replacement');
    // Born approved: queueing the replacement on the ticket IS the
    // authorisation, so there is no second confirmation step in Sales.
    expect(insertArg.status).toBe('approved');
    expect(insertArg.order_ref).toBe('R-0007');
    expect(insertArg.linked_ticket_id).toBe('t1');
    expect(insertArg.cogs_usd).toBeCloseTo(4.2 * 2 + 312, 2);
    expect(insertArg.replacement_state).toBe('ready');
    expect(ticketUpdate).toHaveBeenCalled();
    // The queued marker is a TAG, applied atomically via RPC — the ticket's
    // status is left alone so the operator's workflow state survives.
    expect(rpcMock).toHaveBeenCalledWith('add_ticket_tag', {
      p_ticket_id: 't1', p_tag: 'queued_for_replacement',
    });
    expect(rpcMock).toHaveBeenCalledWith('decrement_part_on_hand', { p_part_id: 'p1', p_qty: 2 });
    expect(unitsUpdate).toHaveBeenCalled();
    // And it lands in the fulfillment queue itself. The auto_enqueue_on_approve
    // trigger only fires `after update of status`, so an INSERT that arrives
    // already-approved never reaches it — without this the order would be
    // approved and visible in nothing.
    expect(queueInsert).toHaveBeenCalledWith(
      expect.objectContaining({ order_id: 'o1' }),
    );
  });

  it('throws when line_items is empty', async () => {
    await expect(createReplacementOrder({
      ticket_id: 't1',
      customer_name: 'X',
      address: { address_line: null, city: '', region_state: null, country: 'CA', postal_code: null },
      line_items: [],
    })).rejects.toThrow(/at least one line item/i);
  });
});

describe('hasPendingLine', () => {
  it('is true when any line is part_pending or unit_pending', () => {
    expect(hasPendingLine([{ kind: 'unit_pending', batch: 'P100X', name: 'P100X', qty: 1, cost_usd: 314 }])).toBe(true);
    expect(hasPendingLine([
      { kind: 'part', part_id: 'p1', sku: 'S', name: 'N', qty: 1, cost_per_unit_usd: 1 },
      { kind: 'part_pending', part_id: 'p2', sku: 'S2', name: 'N2', qty: 1, cost_per_unit_usd: 2 },
    ])).toBe(true);
  });
  it('is false when every line is in stock / ready', () => {
    expect(hasPendingLine([
      { kind: 'part', part_id: 'p1', sku: 'S', name: 'N', qty: 1, cost_per_unit_usd: 1 },
      { kind: 'unit', unit_serial: 'LL01-1', batch: 'P100', name: 'U', qty: 1, cost_usd: 300 },
    ])).toBe(false);
  });
});

describe('createPendingReplacement', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates an awaiting order WITHOUT decrementing stock or reserving units', async () => {
    rpcMock.mockImplementation((name: string) => {
      if (name === 'next_replacement_order_ref') return Promise.resolve({ data: 'R-0050', error: null });
      if (name === 'add_ticket_tag') return Promise.resolve({ data: null, error: null });
      return Promise.resolve({ data: null, error: { message: `unexpected rpc ${name}` } });
    });
    const insertSingle = vi.fn().mockResolvedValue({ data: { id: 'o9', order_ref: 'R-0050' }, error: null });
    const insert = vi.fn().mockReturnValue({ select: vi.fn().mockReturnValue({ single: insertSingle }) });
    const ticketUpdateFn = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) });
    const unitsUpdate = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) });

    fromMock.mockImplementation(((table: string) => {
      if (table === 'orders') return { insert };
      if (table === 'service_tickets') return { update: ticketUpdateFn };
      if (table === 'units') return { update: unitsUpdate };
      throw new Error(`unexpected table ${table}`);
    }) as any);
    logActionMock.mockResolvedValue(undefined);

    const result = await createPendingReplacement({
      ticket_id: 't1',
      customer_name: 'Pat Pending',
      address: { address_line: '1 A St', city: 'Toronto', region_state: 'ON', country: 'CA', postal_code: 'M1M 1M1' },
      line_items: [
        { kind: 'unit_pending', batch: 'P100X', name: 'LILA (P100X)', qty: 1, cost_usd: 314 },
        { kind: 'part_pending', part_id: 'p2', sku: 'LILA-HOPPER', name: 'Hopper', qty: 1, cost_per_unit_usd: 12 },
      ],
    });

    expect(result.order_ref).toBe('R-0050');
    const insertArg = insert.mock.calls[0][0];
    expect(insertArg.replacement_state).toBe('awaiting');
    expect(insertArg.awaiting_batch_id).toBe('P100X');
    // Ticket is back-linked but its status is NOT touched — the operator's
    // workflow state must survive a replacement being queued.
    expect(ticketUpdateFn).toHaveBeenCalledWith({ replacement_order_id: 'o9' });
    // The queued marker is a TAG, applied atomically via RPC.
    expect(rpcMock).toHaveBeenCalledWith('add_ticket_tag', {
      p_ticket_id: 't1', p_tag: 'queued_for_replacement',
    });
    // Crucially: NO stock decrement and NO unit reservation for a pending order.
    expect(rpcMock).not.toHaveBeenCalledWith('decrement_part_on_hand', expect.anything());
    expect(unitsUpdate).not.toHaveBeenCalled();
  });

  it('throws when line_items is empty', async () => {
    await expect(createPendingReplacement({
      ticket_id: 't1', customer_name: 'X',
      address: { address_line: null, city: '', region_state: null, country: 'CA', postal_code: null },
      line_items: [],
    })).rejects.toThrow(/at least one line item/i);
  });
});

describe('markOrderShipped', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sets shipped_at and shipping_cost_usd', async () => {
    const selectSingle = vi.fn().mockResolvedValue({ data: { order_ref: 'R-0001' }, error: null });
    const selectEq = vi.fn().mockReturnValue({ single: selectSingle });
    const select = vi.fn().mockReturnValue({ eq: selectEq });
    const updateEq = vi.fn().mockResolvedValue({ error: null });
    const update = vi.fn().mockReturnValue({ eq: updateEq });
    fromMock.mockReturnValue({ select, update } as any);
    await markOrderShipped('o1', 42.75);
    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      shipping_cost_usd: 42.75,
      shipped_at: expect.any(String),
    }));
    expect(logActionMock).toHaveBeenCalledWith('order_shipped', 'R-0001', expect.any(String), undefined, expect.objectContaining({ klaviyoEvent: 'Order Shipped' }));
  });

  it('clears the queued_for_replacement tag when a replacement ships', async () => {
    const selectSingle = vi.fn().mockResolvedValue({
      data: { order_ref: 'R-0002', customer_email: null, kind: 'replacement', linked_ticket_id: 'ticket-s' },
      error: null,
    });
    const select = vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ single: selectSingle }) });
    const update = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) });
    fromMock.mockReturnValue({ select, update } as any);
    rpcMock.mockResolvedValue({ data: null, error: null });

    await markOrderShipped('o2', 42.75);

    expect(rpcMock).toHaveBeenCalledWith('remove_ticket_tag', {
      p_ticket_id: 'ticket-s', p_tag: 'queued_for_replacement',
    });
  });

  it('does not touch tickets when a non-replacement order ships', async () => {
    const selectSingle = vi.fn().mockResolvedValue({
      data: { order_ref: 'R-0003', customer_email: null, kind: 'sale', linked_ticket_id: null },
      error: null,
    });
    const select = vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ single: selectSingle }) });
    const update = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) });
    fromMock.mockReturnValue({ select, update } as any);

    await markOrderShipped('o3', 42.75);

    expect(rpcMock).not.toHaveBeenCalledWith('remove_ticket_tag', expect.anything());
  });

  it('throws on negative shipping cost', async () => {
    await expect(markOrderShipped('o1', -1)).rejects.toThrow(/non-negative/i);
  });

  it('throws on non-finite shipping cost', async () => {
    await expect(markOrderShipped('o1', Number.NaN)).rejects.toThrow(/non-negative/i);
  });
});

describe('cancelReplacementOrder', () => {
  beforeEach(() => vi.clearAllMocks());

  it('clears the queued_for_replacement tag when a replacement is cancelled', async () => {
    const order = {
      id: 'order-x', order_ref: 'R-0099', kind: 'replacement',
      replacement_state: 'awaiting', linked_ticket_id: 'ticket-x',
      shipped_at: null, delivered_at: null, line_items: [],
    };
    const ticketUpdateEq = vi.fn().mockResolvedValue({ error: null });

    fromMock.mockImplementation(((table: string) => {
      if (table === 'orders') return {
        select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: order, error: null }) }) }),
        delete: () => ({ eq: () => ({ select: () => Promise.resolve({ data: [{ id: 'order-x' }], error: null }) }) }),
      };
      if (table === 'service_tickets') return {
        // The cancel gate reads the ticket status; it must be closed.
        select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { status: 'closed', ticket_number: 'T-1' }, error: null }) }) }),
        update: () => ({ eq: ticketUpdateEq }),
      };
      if (table === 'units') return { update: () => ({ eq: () => ({ eq: () => Promise.resolve({ error: null }) }) }) };
      throw new Error(`unexpected table ${table}`);
    }) as any);
    rpcMock.mockResolvedValue({ data: null, error: null });
    logActionMock.mockResolvedValue(undefined);

    await cancelReplacementOrder('order-x');

    expect(rpcMock).toHaveBeenCalledWith('remove_ticket_tag', {
      p_ticket_id: 'ticket-x', p_tag: 'queued_for_replacement',
    });
  });
});

describe('markOrderDelivered', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sets delivered_at on a sale order without touching tickets', async () => {
    const orderSingle = vi.fn().mockResolvedValue({
      data: { kind: 'sale', linked_ticket_id: null, order_ref: '#1113', delivered_at: null, shipped_at: '2026-06-04T10:00:00Z' }, error: null,
    });
    const orderEqSel = vi.fn().mockReturnValue({ single: orderSingle });
    const orderUpdateEq = vi.fn().mockResolvedValue({ error: null });
    const orderUpdate = vi.fn().mockReturnValue({ eq: orderUpdateEq });
    const ticketUpdate = vi.fn();
    fromMock.mockImplementation(((table: string) => {
      if (table === 'orders') return { update: orderUpdate, select: () => ({ eq: orderEqSel }) };
      if (table === 'service_tickets') return { update: ticketUpdate };
      throw new Error(`unexpected table ${table}`);
    }) as any);
    await markOrderDelivered('o1');
    expect(orderUpdate).toHaveBeenCalledWith(expect.objectContaining({ delivered_at: expect.any(String) }));
    expect(ticketUpdate).not.toHaveBeenCalled();
  });

  it('closes the linked ticket on a replacement order', async () => {
    const orderSingle = vi.fn().mockResolvedValue({
      data: { kind: 'replacement', linked_ticket_id: 't1', order_ref: 'R-0007', delivered_at: null, shipped_at: '2026-06-04T10:00:00Z' }, error: null,
    });
    const orderEqSel = vi.fn().mockReturnValue({ single: orderSingle });
    const orderUpdateEq = vi.fn().mockResolvedValue({ error: null });
    const orderUpdate = vi.fn().mockReturnValue({ eq: orderUpdateEq });
    const ticketUpdateEq = vi.fn().mockResolvedValue({ error: null });
    const ticketUpdate = vi.fn().mockReturnValue({ eq: ticketUpdateEq });
    fromMock.mockImplementation(((table: string) => {
      if (table === 'orders') return { update: orderUpdate, select: () => ({ eq: orderEqSel }) };
      if (table === 'service_tickets') return { update: ticketUpdate };
      throw new Error(`unexpected table ${table}`);
    }) as any);
    await markOrderDelivered('o1');
    expect(orderUpdate).toHaveBeenCalled();
    expect(ticketUpdate).toHaveBeenCalledWith(expect.objectContaining({
      status: 'closed', resolved_at: expect.any(String), closed_at: expect.any(String),
    }));
  });

  it('throws if shipped_at is null', async () => {
    const orderSingle = vi.fn().mockResolvedValue({
      data: { kind: 'sale', linked_ticket_id: null, order_ref: '#1113',
              delivered_at: null, shipped_at: null }, error: null,
    });
    const orderEqSel = vi.fn().mockReturnValue({ single: orderSingle });
    fromMock.mockImplementation(((table: string) => {
      if (table === 'orders') return { select: () => ({ eq: orderEqSel }) };
      throw new Error(`unexpected table ${table}`);
    }) as any);
    await expect(markOrderDelivered('o1')).rejects.toThrow(/not been shipped/i);
  });

  it('is idempotent — early-returns when delivered_at is already set', async () => {
    const orderSingle = vi.fn().mockResolvedValue({
      data: { kind: 'replacement', linked_ticket_id: 't1', order_ref: 'R-0007',
              delivered_at: '2026-06-01T12:00:00Z' }, error: null,
    });
    const orderEqSel = vi.fn().mockReturnValue({ single: orderSingle });
    const orderUpdate = vi.fn();
    const ticketUpdate = vi.fn();
    (fromMock as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      if (table === 'orders') return { update: orderUpdate, select: () => ({ eq: orderEqSel }) };
      if (table === 'service_tickets') return { update: ticketUpdate };
      throw new Error(`unexpected table ${table}`);
    });
    await markOrderDelivered('o1');
    expect(orderUpdate).not.toHaveBeenCalled();
    expect(ticketUpdate).not.toHaveBeenCalled();
  });
});

// bucketOrders is the pure core of useOrders: it decides which orders are
// still live in Order Review and which tab each one lands in. Cancelling is
// terminal, so a cancelled order leaves every live tab — but it keeps a tab of
// its own rather than disappearing from the app entirely.
describe('bucketOrders', () => {
  const mk = (over: Partial<Order> & { id: string; status: Order['status'] }) => ({
    order_ref: `#${over.id}`, customer_name: 'Someone', kind: 'sale',
    cancelled_at: null, ...over,
  }) as Order;

  const none = new Set<string>();

  it('routes each live sale to its status tab', () => {
    const b = bucketOrders(
      [mk({ id: 'a', status: 'pending' }), mk({ id: 'b', status: 'held' }),
       mk({ id: 'c', status: 'flagged' }), mk({ id: 'd', status: 'approved' })],
      none, none,
    );
    expect(b.pending.map(o => o.id)).toEqual(['a']);
    expect(b.held.map(o => o.id)).toEqual(['b']);
    expect(b.flagged.map(o => o.id)).toEqual(['c']);
    expect(b.approved.map(o => o.id)).toEqual(['d']);
    expect(b.cancelled).toEqual([]);
  });

  it('pulls a cancelled order out of every live tab and into cancelled', () => {
    const b = bucketOrders(
      [mk({ id: 'live', status: 'pending' }),
       mk({ id: 'dead', status: 'cancelled', cancelled_at: '2026-08-13T15:03:17Z' })],
      none, none,
    );
    expect(b.pending.map(o => o.id)).toEqual(['live']);
    expect(b.all.map(o => o.id)).toEqual(['live']);
    expect(b.cancelled.map(o => o.id)).toEqual(['dead']);
  });

  it('sorts cancelled newest-first, with never-stamped rows last', () => {
    const b = bucketOrders(
      [mk({ id: 'old',   status: 'cancelled', cancelled_at: '2026-01-01T00:00:00Z' }),
       mk({ id: 'blank', status: 'cancelled' }),
       mk({ id: 'new',   status: 'cancelled', cancelled_at: '2026-08-13T00:00:00Z' })],
      none, none,
    );
    expect(b.cancelled.map(o => o.id)).toEqual(['new', 'old', 'blank']);
  });

  // Sales is sales-only. Replacements are born approved and live in the
  // fulfillment queue; there is no tab here that should ever show one, and
  // `all` and `cancelled` are the two that used to leak.
  it('keeps replacements out of every bucket, whatever their status', () => {
    const b = bucketOrders(
      [mk({ id: 'r-pending',   status: 'pending',   kind: 'replacement' }),
       mk({ id: 'r-approved',  status: 'approved',  kind: 'replacement' }),
       mk({ id: 'r-cancelled', status: 'cancelled', kind: 'replacement' }),
       mk({ id: 's1',          status: 'pending',   kind: 'sale' })],
      none, none,
    );
    expect(b.all.map(o => o.id)).toEqual(['s1']);
    expect(b.pending.map(o => o.id)).toEqual(['s1']);
    expect(b.approved).toEqual([]);
    expect(b.cancelled).toEqual([]);
  });

  it('still hides fulfilled and already-shipped orders from every tab', () => {
    const b = bucketOrders(
      [mk({ id: 'fulfilled', status: 'approved' }),
       mk({ id: 'shipped', status: 'pending', customer_name: 'Ada Ship' })],
      new Set(['fulfilled']), new Set(['ada ship']),
    );
    expect(b.all).toEqual([]);
    expect(b.cancelled).toEqual([]);
  });

  // The shipped-customer signal is a *name* match against any shipped unit, so
  // it also swallows a repeat customer's genuinely new order. An operator who
  // has been through the Reconcile screen and said "nothing shipped against
  // this one" outranks the heuristic.
  it('shows a pending order the shipped-customer match would hide once it is reconciled open', () => {
    const b = bucketOrders(
      [mk({ id: 'reopened', status: 'pending', customer_name: 'Ada Ship', reconcile_outcome: 'open' }),
       mk({ id: 'hidden',   status: 'pending', customer_name: 'Ada Ship' })],
      none, new Set(['ada ship']),
    );
    expect(b.pending.map(o => o.id)).toEqual(['reopened']);
  });

  it('keeps hiding an order reconciled as shipped', () => {
    const b = bucketOrders(
      [mk({ id: 'done', status: 'pending', customer_name: 'Ada Ship', reconcile_outcome: 'shipped' })],
      none, new Set(['ada ship']),
    );
    expect(b.all).toEqual([]);
  });

  // The closed-ticket rule that used to live in bucketOrders is gone with the
  // Replacement tab it served. A sale was never subject to it and still isn't:
  // a sale order's linked ticket says nothing about whether the sale shipped.
  it('does not hide a SALE order just because it has a linked ticket', () => {
    const b = bucketOrders(
      [mk({ id: 's1', status: 'pending', kind: 'sale', linked_ticket_id: 't1' })],
      none, none,
    );
    expect(b.pending.map(o => o.id)).toEqual(['s1']);
  });
});
