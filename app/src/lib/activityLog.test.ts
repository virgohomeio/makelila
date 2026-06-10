import { describe, it, expect, vi, beforeEach } from 'vitest';

const { insertMock, fromMock, getUserMock, invokeMock } = vi.hoisted(() => {
  const insertMock = vi.fn();
  const fromMock = vi.fn(() => ({ insert: insertMock }));
  const getUserMock = vi.fn<() => Promise<{ data: { user: { id: string } | null } }>>(
    () => Promise.resolve({ data: { user: { id: 'user-1' } } }),
  );
  const invokeMock = vi.fn().mockResolvedValue({ data: {}, error: null });
  return { insertMock, fromMock, getUserMock, invokeMock };
});

vi.mock('./supabase', () => ({
  supabase: {
    from: fromMock,
    auth: { getUser: getUserMock },
    functions: { invoke: invokeMock },
    channel: vi.fn(() => ({
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn().mockReturnThis(),
      unsubscribe: vi.fn(),
    })),
  },
}));

import { logAction } from './activityLog';

describe('logAction', () => {
  beforeEach(() => {
    insertMock.mockReset();
    insertMock.mockResolvedValue({ data: null, error: null });
    fromMock.mockClear();
    invokeMock.mockClear();
    invokeMock.mockResolvedValue({ data: {}, error: null });
  });

  it('inserts row with current user_id, type, entity, detail (entity refs null when omitted)', async () => {
    await logAction('order_approve', 'Test Order', '#ORD-0001');
    expect(fromMock).toHaveBeenCalledWith('activity_log');
    expect(insertMock).toHaveBeenCalledWith({
      user_id: 'user-1',
      type: 'order_approve',
      entity: 'Test Order',
      detail: '#ORD-0001',
      entity_type: null,
      entity_id: null,
      unit_serial: null,
    });
  });

  it('defaults detail to empty string', async () => {
    await logAction('order_flag', 'Test');
    expect(insertMock).toHaveBeenCalledWith(expect.objectContaining({ detail: '' }));
  });

  it('throws if no authenticated user', async () => {
    getUserMock.mockResolvedValueOnce({ data: { user: null } });
    await expect(logAction('x', 'y')).rejects.toThrow(/not authenticated/i);
  });

  it('passes entity refs to the insert when supplied', async () => {
    await logAction('stock_status', 'LL01-00000000123', 'ready → reserved', {
      entityType: 'unit',
      unitSerial: 'LL01-00000000123',
    });
    expect(insertMock).toHaveBeenCalledWith(expect.objectContaining({
      entity_type: 'unit',
      unit_serial: 'LL01-00000000123',
      entity_id: null,
    }));
  });

  it('passes entity refs for entity_id-keyed events (return / ticket / order)', async () => {
    await logAction('return_status', 'ret-uuid', '→ received', {
      entityType: 'return',
      entityId: 'ret-uuid',
    });
    expect(insertMock).toHaveBeenCalledWith(expect.objectContaining({
      entity_type: 'return',
      entity_id: 'ret-uuid',
      unit_serial: null,
    }));
  });

  it('fires klaviyo-track edge function when opts.klaviyoEvent is provided', async () => {
    await logAction('order_fulfilled', 'customer@example.com', 'shipped', undefined, {
      klaviyoEvent: 'Order Fulfilled',
    });
    expect(invokeMock).toHaveBeenCalledWith(
      'klaviyo-track',
      expect.objectContaining({
        body: expect.objectContaining({ event: 'Order Fulfilled', email: 'customer@example.com' }),
      }),
    );
  });

  it('does NOT call klaviyo-track when opts.klaviyoEvent is absent', async () => {
    await logAction('order_created', 'customer@example.com', 'new order');
    const klaviyoCalls = invokeMock.mock.calls.filter(c => c[0] === 'klaviyo-track');
    expect(klaviyoCalls).toHaveLength(0);
  });

  it('does NOT throw when klaviyo-track invocation fails', async () => {
    invokeMock.mockRejectedValueOnce(new Error('Klaviyo down'));
    await expect(
      logAction('order_fulfilled', 'customer@example.com', 'shipped', undefined, {
        klaviyoEvent: 'Order Fulfilled',
      }),
    ).resolves.not.toThrow();
  });
});
