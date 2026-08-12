import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const { getSessionMock, fetchMock, presenceMock } = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  fetchMock: vi.fn(),
  presenceMock: vi.fn(),
}));

vi.mock('./supabase', () => ({
  supabase: { auth: { getSession: getSessionMock } },
}));

vi.mock('./supabaseTelemetry', () => ({
  isTelemetryConfigured: true,
  TELEMETRY_URL: 'https://lovely.supabase.co',
  TELEMETRY_ANON_KEY: 'lovely-anon',
}));

vi.mock('./dashboard', () => ({
  fetchTelemetryPresence: presenceMock,
}));

vi.stubGlobal('fetch', fetchMock);

import {
  useLovelyActivity,
  lastActivity,
  appBucket,
  machineState,
  activityStatus,
  buildEntries,
  statusCounts,
  type LovelyActivityRow,
} from './lovelyActivity';
import type { LovelyUser } from './lovely';

// Fixed clock so every relative-time assertion is exact.
const NOW = Date.parse('2026-08-12T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function mkUser(over: Partial<LovelyUser> = {}): LovelyUser {
  return {
    id: 'u1',
    email: 'a@x.com',
    first_name: 'A',
    last_name: 'B',
    serial_number: 'LL01-000000001',
    onboarding_step: 'tour_done',
    is_verified: true,
    verified_at: ago(90 * DAY),
    mailing_list: null,
    last_login_at: null,
    login_count: null,
    created_at: ago(120 * DAY),
    updated_at: null,
    ...over,
  };
}

function mkActivity(over: Partial<LovelyActivityRow> = {}): LovelyActivityRow {
  return {
    user_id: 'u1',
    serial_number: 'LL01-000000001',
    last_notification_read_at: null,
    notifications_unread: 0,
    ota_last_accepted_at: null,
    ota_accept_count: 0,
    last_batch_started_at: null,
    last_batch_completed_at: null,
    active_batch_side: null,
    batch_count: 0,
    last_feedback_at: null,
    feedback_count: 0,
    push_device_count: 0,
    pwa_install_state: 'none',
    pwa_platform: null,
    pwa_last_event_at: null,
    damage_report_count: 0,
    last_damage_at: null,
    ...over,
  };
}

function okResponse(body: unknown) {
  return { ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(body)) };
}
function errResponse(status: number, body: unknown) {
  return { ok: false, status, text: () => Promise.resolve(JSON.stringify(body)) };
}

beforeEach(() => {
  getSessionMock.mockReset();
  fetchMock.mockReset();
  presenceMock.mockReset();
  getSessionMock.mockResolvedValue({ data: { session: { access_token: 'tok' } } });
  presenceMock.mockResolvedValue(new Map());
});

describe('lastActivity', () => {
  it('picks the most recent signal across login, profile, notifications, OTA, batches and feedback', () => {
    const user = mkUser({ last_login_at: ago(20 * DAY), updated_at: ago(15 * DAY) });
    const act = mkActivity({
      last_notification_read_at: ago(3 * DAY),
      ota_last_accepted_at: ago(9 * DAY),
      last_batch_started_at: ago(30 * DAY),
      last_feedback_at: ago(40 * DAY),
    });

    expect(lastActivity(user, act)).toEqual({
      at: ago(3 * DAY),
      signal: 'notification',
    });
  });

  it('reports a login when login is the freshest signal', () => {
    const user = mkUser({ last_login_at: ago(1 * DAY) });
    const act = mkActivity({ last_notification_read_at: ago(5 * DAY) });
    expect(lastActivity(user, act).signal).toBe('login');
  });

  it('works with no activity row at all (users tab data only)', () => {
    const user = mkUser({ last_login_at: ago(2 * DAY) });
    expect(lastActivity(user, null)).toEqual({ at: ago(2 * DAY), signal: 'login' });
  });

  it('returns a null signal when the user has never done anything', () => {
    expect(lastActivity(mkUser(), null)).toEqual({ at: null, signal: null });
  });

  // The approve action in lovely-verify-user writes users.is_verified, which
  // bumps updated_at. Counting that as customer activity would make every
  // freshly-approved user look active on the day an operator approved them.
  it('ignores updated_at when it coincides with the operator approval that caused it', () => {
    const verified = ago(2 * DAY);
    const user = mkUser({
      verified_at: verified,
      updated_at: new Date(Date.parse(verified) + 300).toISOString(),
      last_login_at: ago(60 * DAY),
    });
    expect(lastActivity(user, null)).toEqual({ at: ago(60 * DAY), signal: 'login' });
  });

  it('still counts updated_at when the profile write is clearly separate from approval', () => {
    const user = mkUser({
      verified_at: ago(30 * DAY),
      updated_at: ago(4 * DAY),
      last_login_at: ago(60 * DAY),
    });
    expect(lastActivity(user, null)).toEqual({ at: ago(4 * DAY), signal: 'profile' });
  });
});

describe('appBucket', () => {
  it('buckets by recency of the composite signal', () => {
    expect(appBucket(null, NOW)).toBe('never');
    expect(appBucket(ago(3 * DAY), NOW)).toBe('active');
    expect(appBucket(ago(7 * DAY - MIN), NOW)).toBe('active');
    expect(appBucket(ago(8 * DAY), NOW)).toBe('cooling');
    expect(appBucket(ago(30 * DAY - MIN), NOW)).toBe('cooling');
    expect(appBucket(ago(31 * DAY), NOW)).toBe('dormant');
  });
});

describe('machineState', () => {
  it('distinguishes unpaired, never-seen, online, intermittent and offline', () => {
    expect(machineState(null, null, NOW)).toBe('unpaired');
    expect(machineState('LL01-1', null, NOW)).toBe('never');
    expect(machineState('LL01-1', ago(5 * MIN), NOW)).toBe('online');
    expect(machineState('LL01-1', ago(9 * MIN), NOW)).toBe('online');
    expect(machineState('LL01-1', ago(30 * MIN), NOW)).toBe('intermittent');
    expect(machineState('LL01-1', ago(3 * HOUR), NOW)).toBe('offline');
  });
});

describe('activityStatus', () => {
  it('flags unverified users ahead of everything else', () => {
    expect(activityStatus(mkUser({ is_verified: false }), 'active', 'online')).toBe('unverified');
  });

  it('flags a verified user with no paired serial', () => {
    expect(activityStatus(mkUser({ serial_number: null }), 'active', 'unpaired')).toBe('unpaired');
  });

  it('flags a paired user who has never done anything in the app', () => {
    expect(activityStatus(mkUser(), 'never', 'online')).toBe('never_used');
  });

  it('resolves the app x machine matrix', () => {
    const u = mkUser();
    expect(activityStatus(u, 'active', 'online')).toBe('healthy');
    expect(activityStatus(u, 'cooling', 'intermittent')).toBe('healthy');
    expect(activityStatus(u, 'active', 'offline')).toBe('unit_down');
    expect(activityStatus(u, 'cooling', 'never')).toBe('unit_down');
    expect(activityStatus(u, 'dormant', 'online')).toBe('silent_user');
    expect(activityStatus(u, 'dormant', 'offline')).toBe('at_risk');
  });
});

describe('buildEntries', () => {
  it('joins users to their activity row and telemetry presence', () => {
    const users = [
      mkUser({ id: 'u1', serial_number: 'LL01-1', last_login_at: ago(1 * DAY) }),
      mkUser({ id: 'u2', serial_number: 'LL01-2', last_login_at: ago(90 * DAY) }),
    ];
    const activity = [mkActivity({ user_id: 'u1', serial_number: 'LL01-1', batch_count: 4 })];
    const presence = new Map([
      ['LL01-1', ago(2 * MIN)],
      ['LL01-2', ago(1 * MIN)],
    ]);

    const entries = buildEntries(users, activity, presence, NOW);
    // Indexed by id, not position — buildEntries sorts by actionability.
    const byId = new Map(entries.map(e => [e.user.id, e]));

    expect(entries).toHaveLength(2);
    expect(byId.get('u1')).toMatchObject({
      app: 'active',
      machine: 'online',
      status: 'healthy',
    });
    expect(byId.get('u1')!.activity?.batch_count).toBe(4);
    // Uses the machine but not the app.
    expect(byId.get('u2')).toMatchObject({ app: 'dormant', machine: 'online', status: 'silent_user' });
    expect(byId.get('u2')!.activity).toBeNull();
  });

  it('treats a serial with no telemetry entry as never seen', () => {
    const entries = buildEntries(
      [mkUser({ serial_number: 'LL01-9', last_login_at: ago(1 * DAY) })],
      [],
      new Map(),
      NOW,
    );
    expect(entries[0].machine).toBe('never');
    expect(entries[0].status).toBe('unit_down');
  });

  it('sorts the most actionable rows first', () => {
    const users = [
      mkUser({ id: 'healthy', serial_number: 'LL01-1', last_login_at: ago(1 * DAY) }),
      mkUser({ id: 'down', serial_number: 'LL01-2', last_login_at: ago(1 * DAY) }),
      mkUser({ id: 'risk', serial_number: 'LL01-3', last_login_at: ago(90 * DAY) }),
    ];
    const presence = new Map([['LL01-1', ago(1 * MIN)]]);
    const entries = buildEntries(users, [], presence, NOW);
    expect(entries.map(e => e.status)).toEqual(['unit_down', 'at_risk', 'healthy']);
  });
});

describe('statusCounts', () => {
  it('counts every status, including the ones with no rows', () => {
    const entries = buildEntries(
      [
        mkUser({ id: 'a', serial_number: 'LL01-1', last_login_at: ago(1 * DAY) }),
        mkUser({ id: 'b', serial_number: 'LL01-2', last_login_at: ago(1 * DAY) }),
      ],
      [],
      new Map([['LL01-1', ago(1 * MIN)], ['LL01-2', ago(1 * MIN)]]),
      NOW,
    );
    const counts = statusCounts(entries);
    expect(counts.healthy).toBe(2);
    expect(counts.at_risk).toBe(0);
    expect(counts.unit_down).toBe(0);
  });
});

describe('useLovelyActivity', () => {
  it('loads aggregates via lovely-activity with the operator token + anon apikey', async () => {
    fetchMock.mockResolvedValue(okResponse({ activity: [mkActivity({ batch_count: 2 })] }));

    const { result } = renderHook(() => useLovelyActivity([mkUser()]));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.entries).toHaveLength(1);
    expect(result.current.entries[0].activity?.batch_count).toBe(2);
    expect(result.current.error).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(
      'https://lovely.supabase.co/functions/v1/lovely-activity',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          apikey: 'lovely-anon',
          Authorization: 'Bearer tok',
        }),
      }),
    );
  });

  it('asks telemetry only for the serials that are actually paired', async () => {
    fetchMock.mockResolvedValue(okResponse({ activity: [] }));

    const { result } = renderHook(() =>
      useLovelyActivity([
        mkUser({ id: 'u1', serial_number: 'LL01-1' }),
        mkUser({ id: 'u2', serial_number: null }),
        mkUser({ id: 'u3', serial_number: 'LL01-1' }),
      ]),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(presenceMock).toHaveBeenCalledWith(['LL01-1']);
  });

  it('surfaces the function error body (and status) on a non-2xx response', async () => {
    fetchMock.mockResolvedValue(errResponse(401, { error: 'Unauthorized' }));

    const { result } = renderHook(() => useLovelyActivity([mkUser()]));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toContain('Unauthorized');
    expect(result.current.error).toContain('401');
  });

  // Telemetry is the softer half: losing it should degrade the tab to app-only
  // data rather than blank the whole roster.
  it('still renders app-side data when the telemetry lookup fails', async () => {
    fetchMock.mockResolvedValue(okResponse({ activity: [mkActivity()] }));
    presenceMock.mockRejectedValue(new Error('telemetry down'));

    const { result } = renderHook(() => useLovelyActivity([mkUser()]));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.entries).toHaveLength(1);
    expect(result.current.entries[0].machine).toBe('never');
    expect(result.current.telemetryError).toContain('telemetry down');
    expect(result.current.error).toBeNull();
  });

  it('errors with "Not signed in." and does not call the function when there is no session', async () => {
    getSessionMock.mockResolvedValue({ data: { session: null } });

    const { result } = renderHook(() => useLovelyActivity([mkUser()]));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe('Not signed in.');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
