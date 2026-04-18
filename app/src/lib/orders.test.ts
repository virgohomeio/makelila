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

import { disposition, needInfo, updateNotes } from './orders';

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
    await disposition('order-1', 'approved', 'Looks good');

    expect(fromMock).toHaveBeenCalledWith('orders');
    expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({
      status: 'approved',
      dispositioned_by: 'user-1',
    }));
    expect(eqMock).toHaveBeenCalledWith('id', 'order-1');
    expect(logActionMock).toHaveBeenCalledWith(
      'order_approve',
      expect.any(String),
      'Looks good',
    );
  });

  it.each([
    ['flagged' as const, 'order_flag'],
    ['held' as const,    'order_hold'],
  ])('maps %s → %s', async (status, type) => {
    await disposition('order-2', status, 'reason');
    expect(logActionMock).toHaveBeenCalledWith(type, expect.any(String), 'reason');
  });

  it('throws if unauthenticated', async () => {
    getUserMock.mockResolvedValueOnce({ data: { user: null } });
    await expect(disposition('order-3', 'approved')).rejects.toThrow(/not authenticated/i);
  });

  it('surfaces the UPDATE error', async () => {
    eqMock.mockResolvedValueOnce({ data: null, error: new Error('RLS denied') });
    await expect(disposition('order-4', 'approved')).rejects.toThrow(/RLS denied/);
    expect(logActionMock).not.toHaveBeenCalled();
  });
});

describe('needInfo', () => {
  beforeEach(() => {
    updateMock.mockReset();
    logActionMock.mockReset();
    logActionMock.mockResolvedValue(undefined);
  });

  it('writes activity_log without changing status', async () => {
    await needInfo('order-1', 'Need a photo of the driveway');
    expect(updateMock).not.toHaveBeenCalled();
    expect(logActionMock).toHaveBeenCalledWith(
      'order_need_info',
      expect.any(String),
      'Need a photo of the driveway',
    );
  });
});

describe('updateNotes', () => {
  beforeEach(() => {
    updateMock.mockReset();
    eqMock.mockReset();
    updateMock.mockReturnValue({ eq: eqMock });
    eqMock.mockResolvedValue({ data: null, error: null });
    logActionMock.mockReset();
  });

  it('issues an UPDATE and does not log', async () => {
    await updateNotes('order-1', 'internal follow-up needed');
    expect(updateMock).toHaveBeenCalledWith({ notes: 'internal follow-up needed' });
    expect(eqMock).toHaveBeenCalledWith('id', 'order-1');
    expect(logActionMock).not.toHaveBeenCalled();
  });
});
