import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const { getSessionMock, fetchMock } = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  fetchMock: vi.fn(),
}));

vi.mock('./supabase', () => ({
  supabase: { auth: { getSession: getSessionMock } },
}));

vi.mock('./supabaseTelemetry', () => ({
  isTelemetryConfigured: true,
  TELEMETRY_URL: 'https://lovely.supabase.co',
  TELEMETRY_ANON_KEY: 'lovely-anon',
}));

vi.stubGlobal('fetch', fetchMock);

import { useLovelyUsers } from './lovely';

function okResponse(body: unknown) {
  return { ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(body)) };
}
function errResponse(status: number, body: unknown) {
  return { ok: false, status, text: () => Promise.resolve(JSON.stringify(body)) };
}

beforeEach(() => {
  getSessionMock.mockReset();
  fetchMock.mockReset();
  getSessionMock.mockResolvedValue({ data: { session: { access_token: 'tok' } } });
});

describe('useLovelyUsers', () => {
  it('loads users via the lovely-users function, passing the operator token + anon apikey', async () => {
    fetchMock.mockResolvedValue(okResponse({
      users: [{
        id: '1', email: 'a@x.com', first_name: 'A', last_name: null,
        serial_number: 'LL01', onboarding_step: 'done', is_verified: true,
        verified_at: null, mailing_list: false, last_login_at: null,
        login_count: 3, created_at: null, updated_at: null,
      }],
    }));

    const { result } = renderHook(() => useLovelyUsers());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.users).toHaveLength(1);
    expect(result.current.users[0].email).toBe('a@x.com');
    expect(result.current.error).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(
      'https://lovely.supabase.co/functions/v1/lovely-users',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          apikey: 'lovely-anon',
          Authorization: 'Bearer tok',
        }),
      }),
    );
  });

  it('surfaces the function error body (and status) on a non-2xx response', async () => {
    fetchMock.mockResolvedValue(errResponse(401, { error: 'Unauthorized' }));

    const { result } = renderHook(() => useLovelyUsers());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toContain('Unauthorized');
    expect(result.current.error).toContain('401');
    expect(result.current.users).toHaveLength(0);
  });

  it('errors with "Not signed in." and does not call the function when there is no session', async () => {
    getSessionMock.mockResolvedValue({ data: { session: null } });

    const { result } = renderHook(() => useLovelyUsers());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe('Not signed in.');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.users).toHaveLength(0);
  });
});
