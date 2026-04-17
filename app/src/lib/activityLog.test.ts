import { describe, it, expect, vi, beforeEach } from 'vitest';

const { insertMock, fromMock, getUserMock } = vi.hoisted(() => {
  const insertMock = vi.fn();
  const fromMock = vi.fn(() => ({ insert: insertMock }));
  const getUserMock = vi.fn<() => Promise<{ data: { user: { id: string } | null } }>>(
    () => Promise.resolve({ data: { user: { id: 'user-1' } } }),
  );
  return { insertMock, fromMock, getUserMock };
});

vi.mock('./supabase', () => ({
  supabase: {
    from: fromMock,
    auth: { getUser: getUserMock },
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
  });

  it('inserts row with current user_id, type, entity, detail', async () => {
    await logAction('order_approve', 'Test Order', '#ORD-0001');
    expect(fromMock).toHaveBeenCalledWith('activity_log');
    expect(insertMock).toHaveBeenCalledWith({
      user_id: 'user-1',
      type: 'order_approve',
      entity: 'Test Order',
      detail: '#ORD-0001',
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
});
