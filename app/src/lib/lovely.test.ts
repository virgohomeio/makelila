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

import { useLovelyUsers, onboardingFunnel, approveLovelyUser, type LovelyUser } from './lovely';

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

describe('onboardingFunnel', () => {
  const mk = (step: string | null): LovelyUser => ({
    id: step ?? 'x', email: 'a@x.com', first_name: null, last_name: null,
    serial_number: null, onboarding_step: step, is_verified: true, verified_at: null,
    mailing_list: null, last_login_at: null, login_count: null, created_at: null, updated_at: null,
  });

  it('returns canonical steps in order with counts and percentages', () => {
    const rows = onboardingFunnel([mk('tour_done'), mk('tour_done'), mk('pairing'), mk('hardware_done')]);
    expect(rows.slice(0, 2).map(r => r.code)).toEqual(['pairing', 'welcome_done']);
    const tour = rows.find(r => r.code === 'tour_done')!;
    expect(tour.count).toBe(2);
    expect(tour.pct).toBe(50);
    expect(rows.find(r => r.code === 'pairing')!.count).toBe(1);
  });

  it('appends unknown step codes after the canonical ones', () => {
    const rows = onboardingFunnel([mk('mystery_step')]);
    expect(rows[rows.length - 1]).toMatchObject({ code: 'mystery_step', count: 1 });
  });
});

describe('approveLovelyUser', () => {
  it('POSTs user_id with the operator token and resolves on 2xx', async () => {
    fetchMock.mockResolvedValue(okResponse({ user: {} }));
    await approveLovelyUser('u-1');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://lovely.supabase.co/functions/v1/lovely-verify-user',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ apikey: 'lovely-anon', Authorization: 'Bearer tok' }),
        body: JSON.stringify({ user_id: 'u-1' }),
      }),
    );
  });

  it('throws the function error body on a non-2xx response', async () => {
    fetchMock.mockResolvedValue(errResponse(403, { error: 'Forbidden — leadership only' }));
    await expect(approveLovelyUser('u-1')).rejects.toThrow(/Forbidden/);
  });
});
