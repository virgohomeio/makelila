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

import { disposition, needInfo, nextReplacementOrderRef, createReplacementOrder, markOrderShipped, markOrderDelivered } from './orders';

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
      return Promise.resolve({ data: null, error: { message: `unexpected rpc ${name}` } });
    });
    const insertSingle = vi.fn().mockResolvedValue({ data: { id: 'o1', order_ref: 'R-0007' }, error: null });
    const select = vi.fn().mockReturnValue({ single: insertSingle });
    const insert = vi.fn().mockReturnValue({ select });
    const ticketUpdate = vi.fn().mockResolvedValue({ error: null });
    const unitsUpdate = vi.fn().mockResolvedValue({ error: null });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fromMock.mockImplementation(((table: string) => {
      if (table === 'orders') return { insert };
      if (table === 'service_tickets') return { update: () => ({ eq: ticketUpdate }) };
      if (table === 'units') return { update: () => ({ eq: unitsUpdate }) };
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
    expect(insertArg.status).toBe('pending');
    expect(insertArg.order_ref).toBe('R-0007');
    expect(insertArg.linked_ticket_id).toBe('t1');
    expect(insertArg.cogs_usd).toBeCloseTo(4.2 * 2 + 312, 2);
    expect(ticketUpdate).toHaveBeenCalled();
    expect(rpcMock).toHaveBeenCalledWith('decrement_part_on_hand', { p_part_id: 'p1', p_qty: 2 });
    expect(unitsUpdate).toHaveBeenCalled();
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

describe('markOrderShipped', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sets shipped_at and shipping_cost_usd', async () => {
    const selectSingle = vi.fn().mockResolvedValue({ data: { order_ref: 'R-0001' }, error: null });
    const selectEq = vi.fn().mockReturnValue({ single: selectSingle });
    const select = vi.fn().mockReturnValue({ eq: selectEq });
    const updateEq = vi.fn().mockResolvedValue({ error: null });
    const update = vi.fn().mockReturnValue({ eq: updateEq });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fromMock.mockReturnValue({ select, update } as any);
    await markOrderShipped('o1', 42.75);
    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      shipping_cost_usd: 42.75,
      shipped_at: expect.any(String),
    }));
    expect(logActionMock).toHaveBeenCalledWith('order_shipped', 'R-0001', expect.any(String));
  });

  it('throws on negative shipping cost', async () => {
    await expect(markOrderShipped('o1', -1)).rejects.toThrow(/non-negative/i);
  });

  it('throws on non-finite shipping cost', async () => {
    await expect(markOrderShipped('o1', Number.NaN)).rejects.toThrow(/non-negative/i);
  });
});

describe('markOrderDelivered', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sets delivered_at on a sale order without touching tickets', async () => {
    const orderSingle = vi.fn().mockResolvedValue({
      data: { kind: 'sale', linked_ticket_id: null, order_ref: '#1113', delivered_at: null }, error: null,
    });
    const orderEqSel = vi.fn().mockReturnValue({ single: orderSingle });
    const orderUpdateEq = vi.fn().mockResolvedValue({ error: null });
    const orderUpdate = vi.fn().mockReturnValue({ eq: orderUpdateEq });
    const ticketUpdate = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
      data: { kind: 'replacement', linked_ticket_id: 't1', order_ref: 'R-0007', delivered_at: null }, error: null,
    });
    const orderEqSel = vi.fn().mockReturnValue({ single: orderSingle });
    const orderUpdateEq = vi.fn().mockResolvedValue({ error: null });
    const orderUpdate = vi.fn().mockReturnValue({ eq: orderUpdateEq });
    const ticketUpdateEq = vi.fn().mockResolvedValue({ error: null });
    const ticketUpdate = vi.fn().mockReturnValue({ eq: ticketUpdateEq });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
