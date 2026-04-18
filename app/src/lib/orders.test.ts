import { describe, it, expect, vi, beforeEach } from 'vitest';

const { updateMock, eqMock, fromMock, getUserMock, logActionMock } = vi.hoisted(() => {
  const updateMock = vi.fn();
  const eqMock = vi.fn();
  // All .from() calls in these tests go through 'orders'; logAction is fully mocked.
  const fromMock = vi.fn(() => ({ update: updateMock }));
  const getUserMock = vi.fn<() => Promise<{ data: { user: { id: string } | null } }>>(
    () => Promise.resolve({ data: { user: { id: 'user-1' } } }),
  );
  const logActionMock = vi.fn(() => Promise.resolve());
  return { updateMock, eqMock, fromMock, getUserMock, logActionMock };
});

vi.mock('./supabase', () => ({
  supabase: {
    from: fromMock,
    auth: { getUser: getUserMock },
  },
}));
vi.mock('./activityLog', () => ({
  logAction: logActionMock,
}));

import { disposition, needInfo } from './orders';

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

