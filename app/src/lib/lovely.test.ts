/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const { invokeMock, getSessionMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  getSessionMock: vi.fn(),
}));

vi.mock('./supabase', () => ({
  supabase: { auth: { getSession: getSessionMock } },
}));

vi.mock('./supabaseTelemetry', () => ({
  isTelemetryConfigured: true,
  supabaseTelemetry: { functions: { invoke: invokeMock } },
}));

import { useLovelyUsers } from './lovely';

beforeEach(() => {
  invokeMock.mockReset();
  getSessionMock.mockReset();
  getSessionMock.mockResolvedValue({ data: { session: { access_token: 'tok' } } });
});

describe('useLovelyUsers', () => {
  it('loads users from the lovely-users function with the operator token', async () => {
    invokeMock.mockResolvedValue({
      data: {
        users: [{
          id: '1', email: 'a@x.com', first_name: 'A', last_name: null,
          serial_number: 'LL01', onboarding_step: 'done', is_verified: true,
          verified_at: null, mailing_list: false, last_login_at: null,
          login_count: 3, created_at: null, updated_at: null,
        }],
      },
      error: null,
    });

    const { result } = renderHook(() => useLovelyUsers());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.users).toHaveLength(1);
    expect(result.current.users[0].email).toBe('a@x.com');
    expect(result.current.error).toBeNull();
    expect(invokeMock).toHaveBeenCalledWith('lovely-users', {
      headers: { Authorization: 'Bearer tok' },
    });
  });

  it('surfaces an error when the function fails', async () => {
    invokeMock.mockResolvedValue({ data: null, error: new Error('boom') });

    const { result } = renderHook(() => useLovelyUsers());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe('boom');
    expect(result.current.users).toHaveLength(0);
  });
});
