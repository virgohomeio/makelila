// Mock fixtures pass `as any` to satisfy the polymorphic supabase client
// surface — this is the right escape valve for test mocks.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── hoisted mock state ──────────────────────────────────────────────────────
const { upsertMock, maybeSingleMock, fromMock, logActionMock } = vi.hoisted(() => {
  const maybeSingleMock = vi.fn<() => Promise<{ data: unknown; error: null }>>();
  const eqMock = vi.fn(() => ({ maybeSingle: maybeSingleMock }));
  const selectMock = vi.fn(() => ({ eq: eqMock }));
  const upsertMock = vi.fn<() => Promise<{ error: null }>>();
  const logActionMock = vi.fn(() => Promise.resolve());

  // fromMock returns different shapes depending on which table / call site is
  // invoking it.  We track calls ourselves and rely on maybeSingleMock /
  // upsertMock being configured per-test.
  const fromMock = vi.fn((_table: string) => ({
    select: selectMock,
    upsert: upsertMock,
  }));

  return { upsertMock, maybeSingleMock, fromMock, logActionMock };
});

vi.mock('./supabase', () => ({
  supabase: {
    from: fromMock,
    auth: {
      getSession: vi.fn(() =>
        Promise.resolve({ data: { session: { access_token: 'tok' } } }),
      ),
      getUser: vi.fn(() =>
        Promise.resolve({ data: { user: { id: 'user-1' } } }),
      ),
    },
    channel: vi.fn(() => ({
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn().mockReturnThis(),
      unsubscribe: vi.fn(),
    })),
  },
  SUPABASE_URL: 'https://test.supabase.co',
  SUPABASE_ANON_KEY: 'anon-key',
}));

vi.mock('./activityLog', () => ({
  logAction: logActionMock,
}));

// ── import after mocks ──────────────────────────────────────────────────────
import { parseUtm, upsertHubSpotContact, followUpDueDates, computeFuState, type Customer } from './customers';

const base: Customer = {
  id: 'c1', hubspot_id: null, email: 'a@b.com', first_name: null, last_name: null,
  full_name: 'Test User', phone: null, address_line: null, city: null, region: null,
  postal_code: null, country: null, notes: null, onboard_date: null,
  color: null, shipped_on: null, received_on: null, diagnosis_on: null,
  dashboard: null, software: null, timezone: null,
  fu1_status: null, fu2_status: null, fu_notes: null, review_status: null, manual_status_tags: null,
  last_synced_at: null, serials: null, serials_synced_at: null,
  name_request_sent_at: null, journey_stage_override: null,
  journey_stage_override_at: null, journey_stage_override_by: null,
  first_touch_source: null, first_touch_campaign_id: null, first_touch_at: null,
  last_touch_source: null, last_touch_campaign_id: null, last_touch_at: null,
  telemetry_autoticket_suppress: false, created_at: '', updated_at: '',
};

// ── parseUtm (existing tests) ───────────────────────────────────────────────
describe('parseUtm', () => {
  it('extracts utm_source and utm_campaign from a URL', () => {
    expect(
      parseUtm('https://lila.vip/?utm_source=facebook&utm_campaign=spring-2026-q1&fbclid=abc'),
    ).toEqual({ source: 'facebook', campaign: 'spring-2026-q1' });
  });

  it('returns shopify_direct when no UTM params are present', () => {
    expect(parseUtm('https://lila.vip/')).toEqual({ source: 'shopify_direct', campaign: null });
  });

  it('returns null for both on empty / null input', () => {
    expect(parseUtm('')).toEqual({ source: null, campaign: null });
    expect(parseUtm(null)).toEqual({ source: null, campaign: null });
  });

  it('handles malformed URL gracefully', () => {
    expect(parseUtm('not a url %^&')).toEqual({ source: null, campaign: null });
  });

  it('returns utm_source only when utm_campaign is absent', () => {
    expect(parseUtm('https://lila.vip/?utm_source=google')).toEqual({
      source: 'google',
      campaign: null,
    });
  });
});

// ── upsertHubSpotContact — insert-only guard ────────────────────────────────
describe('upsertHubSpotContact — insert-only guard', () => {
  beforeEach(() => {
    upsertMock.mockReset();
    maybeSingleMock.mockReset();
    logActionMock.mockReset();
    upsertMock.mockResolvedValue({ error: null });
    logActionMock.mockResolvedValue(undefined);
  });

  it('inserts name + phone for a brand-new customer (no existing record)', async () => {
    maybeSingleMock.mockResolvedValue({ data: null, error: null });

    await upsertHubSpotContact({
      email: 'new@example.com',
      name: 'Alice Smith',
      phone: '+16045551234',
      hs_analytics_source: 'hubspot',
    });

    expect(upsertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'new@example.com',
        name: 'Alice Smith',
        phone: '+16045551234',
        first_touch_source: 'hubspot',
      }),
      expect.objectContaining({ onConflict: 'email' }),
    );
  });

  it('does NOT include name or phone in the upsert when customer already exists', async () => {
    maybeSingleMock.mockResolvedValue({
      data: { id: 'cust-1', name: 'Existing Name', phone: '+16045559999' },
      error: null,
    });

    await upsertHubSpotContact({
      email: 'existing@example.com',
      name: 'Different Name from HubSpot',
      phone: '+10000000000',
      hs_analytics_source: 'hubspot',
    });

    const upsertArg = (upsertMock.mock.calls as any[][])[0][0] as Record<string, unknown>;
    expect(upsertArg).not.toHaveProperty('name');
    expect(upsertArg).not.toHaveProperty('phone');
  });

  it('still writes first_touch_source when customer already exists', async () => {
    maybeSingleMock.mockResolvedValue({
      data: { id: 'cust-1', name: 'Existing Name', phone: '+16045559999' },
      error: null,
    });

    await upsertHubSpotContact({
      email: 'existing@example.com',
      name: 'Different Name',
      phone: '+10000000000',
      hs_analytics_source: 'facebook_ad',
    });

    const upsertArg = (upsertMock.mock.calls as any[][])[0][0] as Record<string, unknown>;
    expect(upsertArg).toMatchObject({
      email: 'existing@example.com',
      first_touch_source: 'facebook_ad',
    });
  });

  it('omits first_touch_source from upsert when hs_analytics_source is null', async () => {
    maybeSingleMock.mockResolvedValue({ data: null, error: null });

    await upsertHubSpotContact({
      email: 'no-source@example.com',
      name: 'Bob',
      hs_analytics_source: null,
    });

    const upsertArg = (upsertMock.mock.calls as any[][])[0][0] as Record<string, unknown>;
    expect(upsertArg).not.toHaveProperty('first_touch_source');
  });

  it('logs "updated (attribution only)" for an existing customer', async () => {
    maybeSingleMock.mockResolvedValue({
      data: { id: 'cust-1', name: 'Existing', phone: null },
      error: null,
    });

    await upsertHubSpotContact({ email: 'existing@example.com' });

    expect(logActionMock).toHaveBeenCalledWith(
      'hubspot_contact_synced',
      'existing@example.com',
      'updated (attribution only)',
    );
  });

  it('logs "inserted (new customer)" for a brand-new customer', async () => {
    maybeSingleMock.mockResolvedValue({ data: null, error: null });

    await upsertHubSpotContact({ email: 'new2@example.com', name: 'Carol' });

    expect(logActionMock).toHaveBeenCalledWith(
      'hubspot_contact_synced',
      'new2@example.com',
      'inserted (new customer)',
    );
  });

  it('throws when upsert returns an error', async () => {
    maybeSingleMock.mockResolvedValue({ data: null, error: null });
    upsertMock.mockResolvedValue({ error: { message: 'DB error' } as any });

    await expect(
      upsertHubSpotContact({ email: 'fail@example.com' }),
    ).rejects.toThrow('DB error');
  });
});

describe('followUpDueDates', () => {
  // Dates are built at LOCAL midnight, so compare local calendar dates (not UTC)
  // to stay robust across timezones.
  const fmtLocal = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  it('returns FU1 at +14d and FU2 at +28d from the anchor', () => {
    const { fu1Due, fu2Due } = followUpDueDates('2026-06-01');
    expect(fmtLocal(fu1Due)).toBe('2026-06-15');
    expect(fmtLocal(fu2Due)).toBe('2026-06-29');
  });
});

describe('computeFuState anchor override', () => {
  const today = new Date('2026-07-01T12:00:00');
  it('uses onboard_date when no anchor is passed', () => {
    const c = { ...base, onboard_date: '2026-05-01' }; // FU1 due 05-15 → overdue by 07-01
    expect(computeFuState(c, today)).toBe('overdue_fu1');
  });
  it('uses the anchor override instead of onboard_date', () => {
    const c = { ...base, onboard_date: '2026-05-01' };
    // Anchor 06-25 → FU1 due 07-09 → still upcoming on 07-01
    expect(computeFuState(c, today, '2026-06-25')).toBe('upcoming_fu1');
  });
});
