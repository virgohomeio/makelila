import { describe, it, expect, vi, beforeEach } from 'vitest';

// Minimal PostgREST-shaped query builder. Every filter method returns the
// builder, and the builder is thenable, so `await client.from(t).select(...)`
// resolves to whatever `handler` decides for the accumulated query state.
type QueryState = {
  table: string;
  inValues?: string[];
  eqValue?: string;
  gteValue?: string;
  ordered?: boolean;
};
type Handler = (q: QueryState) => { data: unknown[] | null; error: { message: string } | null };

// Hoisted: vi.mock factories run before module-level statements, so everything
// the factory closes over has to be created inside vi.hoisted.
const { calls, state, telemetryClient } = vi.hoisted(() => {
  const calls: QueryState[] = [];
  const state: { handler: Handler } = {
    handler: () => ({ data: [], error: null }),
  };

  function builder(table: string) {
    const q: QueryState = { table };
    const b = {
      select: () => b,
      in: (_col: string, values: string[]) => { q.inValues = values; return b; },
      eq: (_col: string, value: string) => { q.eqValue = value; return b; },
      gte: (_col: string, value: string) => { q.gteValue = value; return b; },
      order: () => { q.ordered = true; return b; },
      limit: () => b,
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
        calls.push({ ...q });
        return Promise.resolve(state.handler({ ...q })).then(resolve, reject);
      },
    };
    return b;
  }

  return { calls, state, telemetryClient: { from: (table: string) => builder(table) } };
});

// Tests assign to `handler`; the hoisted builder reads through this indirection.
let handler: Handler = () => ({ data: [], error: null });
state.handler = q => handler(q);

vi.mock('./supabaseTelemetry', () => ({
  supabaseTelemetry: telemetryClient,
  isTelemetryConfigured: true,
  TELEMETRY_URL: 'https://lovely.supabase.co',
  TELEMETRY_ANON_KEY: 'lovely-anon',
}));
vi.mock('./supabase', () => ({ supabase: {} }));
vi.mock('./activityLog', () => ({ logAction: vi.fn() }));

import { fetchTelemetryPresence } from './dashboard';

const MIN = 60_000;
const HOUR = 3_600_000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

// Tier 1 batches by serial list; tiers 2 and 3 query one serial at a time and
// differ only in whether they bound the scan by created_at.
const isTier1 = (q: QueryState) => !!q.inValues;
const isTier2 = (q: QueryState) => !!q.eqValue && !!q.gteValue;
const isTier3 = (q: QueryState) => !!q.eqValue && !q.gteValue;

const timeout = { message: 'canceling statement due to statement timeout' };

beforeEach(() => {
  calls.length = 0;
  handler = () => ({ data: [], error: null });
});

describe('fetchTelemetryPresence', () => {
  it('resolves a live machine from the batched first tier', async () => {
    const seenAt = iso(2 * MIN);
    handler = q =>
      isTier1(q) && q.table === 'events'
        ? { data: [{ serial_number: 'LL01-1', created_at: seenAt }], error: null }
        : { data: [], error: null };

    const { presence, warnings } = await fetchTelemetryPresence(['LL01-1']);

    expect(presence.get('LL01-1')).toEqual({ at: seenAt, exact: true });
    expect(warnings).toEqual([]);
    // Resolved in tier 1, so it never reaches the per-serial tiers.
    expect(calls.some(isTier2)).toBe(false);
  });

  it('takes the newest timestamp across the telemetry tables', async () => {
    const older = iso(9 * MIN);
    const newer = iso(1 * MIN);
    handler = q => {
      if (!isTier1(q)) return { data: [], error: null };
      if (q.table === 'events') return { data: [{ serial_number: 'LL01-1', created_at: older }], error: null };
      if (q.table === 'bme_sensors') return { data: [{ serial_number: 'LL01-1', created_at: newer }], error: null };
      return { data: [], error: null };
    };

    const { presence } = await fetchTelemetryPresence(['LL01-1']);
    expect(presence.get('LL01-1')).toEqual({ at: newer, exact: true });
  });

  // The regression that started all of this: an unbounded per-serial lookup
  // scans the whole (created_at, serial_number) index backward — ~11.7s on
  // bme_sensors, past the statement timeout.
  it('bounds the per-serial lookup by created_at so it cannot scan all history', async () => {
    await fetchTelemetryPresence(['LL01-quiet']);

    const tier2 = calls.filter(isTier2);
    expect(tier2.length).toBeGreaterThan(0);
    for (const q of tier2) {
      const windowMs = Date.now() - Date.parse(q.gteValue!);
      // 24h window, allowing for the elapsed test runtime.
      expect(windowMs).toBeGreaterThan(23 * HOUR);
      expect(windowMs).toBeLessThan(25 * HOUR);
    }
  });

  it('records silence over the window as inexact rather than never-seen', async () => {
    // Tiers 1 and 2 find nothing; tier 3 (unbounded) times out, as it does
    // until the serial_number index exists.
    handler = q => (isTier3(q) ? { data: null, error: timeout } : { data: [], error: null });

    const { presence, warnings } = await fetchTelemetryPresence(['LL01-quiet']);

    expect(presence.get('LL01-quiet')).toEqual({ at: null, exact: false });
    expect(warnings.join(' ')).toContain('statement timeout');
  });

  it('upgrades to the exact last-seen date when the unbounded tier succeeds', async () => {
    const longAgo = iso(40 * 24 * HOUR);
    handler = q =>
      isTier3(q) && q.table === 'events'
        ? { data: [{ created_at: longAgo }], error: null }
        : { data: [], error: null };

    const { presence } = await fetchTelemetryPresence(['LL01-quiet']);
    expect(presence.get('LL01-quiet')).toEqual({ at: longAgo, exact: true });
  });

  it('reports a serial as never seen when every tier answers and finds nothing', async () => {
    const { presence, warnings } = await fetchTelemetryPresence(['LL01-nothing']);
    expect(presence.get('LL01-nothing')).toEqual({ at: null, exact: true });
    expect(warnings).toEqual([]);
  });

  // Previously `throw error` inside Promise.all, which discarded presence for
  // every serial — the whole roster then rendered as down.
  it('keeps the serials it did resolve when another serial fails outright', async () => {
    const seenAt = iso(2 * MIN);
    handler = q => {
      if (isTier1(q)) {
        return q.table === 'events'
          ? { data: [{ serial_number: 'LL01-live', created_at: seenAt }], error: null }
          : { data: [], error: null };
      }
      // Every per-serial read for the other machine fails.
      return { data: null, error: timeout };
    };

    const { presence, warnings } = await fetchTelemetryPresence(['LL01-live', 'LL01-broken']);

    expect(presence.get('LL01-live')).toEqual({ at: seenAt, exact: true });
    // Absent, not null: we learned nothing, so the caller must not call it down.
    expect(presence.has('LL01-broken')).toBe(false);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('survives one telemetry table failing in the batched tier', async () => {
    const seenAt = iso(3 * MIN);
    handler = q => {
      if (!isTier1(q)) return { data: [], error: null };
      if (q.table === 'bme_sensors') return { data: null, error: { message: 'relation missing' } };
      return { data: [{ serial_number: 'LL01-1', created_at: seenAt }], error: null };
    };

    const { presence, warnings } = await fetchTelemetryPresence(['LL01-1']);

    expect(presence.get('LL01-1')).toEqual({ at: seenAt, exact: true });
    expect(warnings).toEqual(['bme_sensors: relation missing']);
  });

  // Without the index every unbounded lookup times out. Trying all of them
  // costs ~12s each and improves nothing, so the first failure closes the tier.
  it('stops attempting unbounded lookups after the first failure', async () => {
    handler = q => (isTier3(q) ? { data: null, error: timeout } : { data: [], error: null });

    const serials = ['LL01-a', 'LL01-b', 'LL01-c', 'LL01-d'];
    const { presence } = await fetchTelemetryPresence(serials);

    // 4 serials x 3 tables = 12 possible unbounded reads; the breaker trips well short.
    expect(calls.filter(isTier3).length).toBeLessThan(12);
    // Tier 2's conclusion still stands for all of them.
    for (const s of serials) expect(presence.get(s)).toEqual({ at: null, exact: false });
  });

  it('does not query at all for an empty serial list', async () => {
    const { presence, warnings } = await fetchTelemetryPresence([]);
    expect(presence.size).toBe(0);
    expect(warnings).toEqual([]);
    expect(calls).toEqual([]);
  });
});
