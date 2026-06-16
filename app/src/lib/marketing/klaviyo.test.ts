import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const { fromMock, invokeMock } = vi.hoisted(() => {
  const limitMock = vi.fn().mockResolvedValue({
    data: [{ id: 'log-1', synced_at: '2026-06-10T02:00:00Z', profiles_sent: 120, errors: 0, detail: null }],
    error: null,
  });
  const orderMock = vi.fn(() => ({ limit: limitMock }));
  const selectMock = vi.fn(() => ({ order: orderMock }));
  const fromMock = vi.fn(() => ({ select: selectMock }));
  const invokeMock = vi.fn().mockResolvedValue({ data: { profiles_sent: 120, errors: 0 }, error: null });
  return { fromMock, invokeMock };
});

vi.mock('../supabase', () => ({
  supabase: {
    from: fromMock,
    functions: { invoke: invokeMock },
  },
}));

import { useKlaviyoSyncStatus, triggerKlaviyoSync } from './klaviyo';

describe('useKlaviyoSyncStatus', () => {
  it('returns last sync log entries', async () => {
    const { result } = renderHook(() => useKlaviyoSyncStatus());
    await waitFor(() => expect(result.current.logs).toHaveLength(1));
    expect(result.current.logs[0].profiles_sent).toBe(120);
  });
});

describe('triggerKlaviyoSync', () => {
  it('invokes the edge function and returns result', async () => {
    const result = await triggerKlaviyoSync();
    expect(result.profiles_sent).toBe(120);
    expect(invokeMock).toHaveBeenCalledWith('sync-klaviyo-profiles');
  });
});
