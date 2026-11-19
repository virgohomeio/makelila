import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useDeviceContext } from '../service';

// ── Supabase mock ────────────────────────────────────────────────────────────
//
// The hook calls supabase.from(...) for three tables in parallel:
//   units            → .select().eq().maybeSingle()
//   service_tickets  → .select(..., {count:'exact', head:true}).eq()…  → { count }
//   returns          → .select(..., {count:'exact', head:true}).eq()   → { count }
//
// The builder is a Proxy so ANY chain method works, and every call is recorded
// per table. Recording matters: the open-ticket count is only correct if the
// right *filters* are applied, and a mock that returns a fixed count no matter
// what is asked cannot tell a scoped query from an unscoped one.

type TableResult = { data: unknown; error: unknown; count?: number | null };
type Call = [string, ...unknown[]];

const tableResults: Record<string, TableResult> = {};
const tableCalls: Record<string, Call[]> = {};

const makeQueryBuilder = (table: string, result: TableResult) => {
  const calls: Call[] = [];
  tableCalls[table] = calls;

  const proxy: Record<string, unknown> = new Proxy({}, {
    get(_t, prop) {
      if (typeof prop === 'symbol') return undefined;
      // Thenable: `await builder` / Promise.all resolves to the table result.
      if (prop === 'then') {
        return (res: (v: TableResult) => unknown, rej: (e: unknown) => unknown) =>
          Promise.resolve(result).then(res, rej);
      }
      // Terminal row-getters resolve instead of continuing the chain.
      if (prop === 'maybeSingle' || prop === 'single') {
        return (...args: unknown[]) => {
          calls.push([prop, ...args]);
          return Promise.resolve(result);
        };
      }
      return (...args: unknown[]) => { calls.push([prop, ...args]); return proxy; };
    },
  }) as Record<string, unknown>;

  return proxy;
};

vi.mock('../supabase', () => ({
  supabase: {
    from: (table: string) => {
      const result: TableResult = tableResults[table] ?? { data: null, error: null, count: 0 };
      return makeQueryBuilder(table, result);
    },
    auth: {
      // useWarrantyRegistration never fires when unitSerial is null; for
      // non-null serials it queries 'warranty_registrations' which we can
      // add to tableResults. For these tests we keep it null/empty.
      getUser: () => Promise.resolve({ data: { user: null } }),
    },
  },
}));

// Mock supabaseTelemetry so it doesn't require env vars.
vi.mock('../supabaseTelemetry', () => ({
  isTelemetryConfigured: false,
  supabaseTelemetry: null,
}));

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('useDeviceContext', () => {
  beforeEach(() => {
    // Reset per-table results to safe defaults before each test.
    Object.keys(tableResults).forEach(k => { delete tableResults[k]; });
    Object.keys(tableCalls).forEach(k => { delete tableCalls[k]; });
    tableResults['units']              = { data: null,  error: null, count: null };
    tableResults['service_tickets']    = { data: null,  error: null, count: 0    };
    tableResults['returns']            = { data: null,  error: null, count: 0    };
    tableResults['warranty_registrations'] = { data: null, error: null, count: null };
  });

  it('returns loading=false and zero counts when unitSerial is null', async () => {
    const { result } = renderHook(() => useDeviceContext(null));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.openTicketCount).toBe(0);
    expect(result.current.returnCount).toBe(0);
    expect(result.current.unit).toBeNull();
    expect(result.current.telemetry).toBeNull();
  });

  it('surfaces openTicketCount from the service_tickets count query', async () => {
    tableResults['service_tickets'] = { data: null, error: null, count: 3 };

    const { result } = renderHook(() => useDeviceContext('LL01-001'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.openTicketCount).toBe(3);
    expect(result.current.returnCount).toBe(0);
  });

  // ── The chip must count the same population the Support tab shows ──────────
  //
  // `service_tickets` is a multi-purpose table: kind='conversation' rows are
  // untriaged Gmail/Quo threads (never closed), and category onboarding /
  // diagnosis_call tickets close out in customer_lifecycle rather than via
  // status. Counting any of them inflates the chip against the queue.

  it('counts only kind=ticket rows, so inbox conversations are excluded', async () => {
    renderHook(() => useDeviceContext('LL01-001'));
    await waitFor(() => expect(tableCalls['service_tickets']).toBeTruthy());
    expect(tableCalls['service_tickets']).toContainEqual(['eq', 'kind', 'ticket']);
  });

  it('counts only support-category tickets, so onboarding/diagnosis calls are excluded', async () => {
    renderHook(() => useDeviceContext('LL01-001'));
    await waitFor(() => expect(tableCalls['service_tickets']).toBeTruthy());
    expect(tableCalls['service_tickets']).toContainEqual(['eq', 'category', 'support']);
  });

  it('scopes the count to the unit and to non-closed tickets', async () => {
    renderHook(() => useDeviceContext('LL01-001'));
    await waitFor(() => expect(tableCalls['service_tickets']).toBeTruthy());
    expect(tableCalls['service_tickets']).toContainEqual(['eq', 'unit_serial', 'LL01-001']);
    expect(tableCalls['service_tickets']).toContainEqual(['neq', 'status', 'closed']);
  });

  it('excludes the ticket being viewed when excludeTicketId is given', async () => {
    renderHook(() => useDeviceContext('LL01-001', 'ticket-abc'));
    await waitFor(() => expect(tableCalls['service_tickets']).toBeTruthy());
    expect(tableCalls['service_tickets']).toContainEqual(['neq', 'id', 'ticket-abc']);
  });

  it('does not filter on id when no ticket is being viewed', async () => {
    renderHook(() => useDeviceContext('LL01-001'));
    await waitFor(() => expect(tableCalls['service_tickets']).toBeTruthy());
    expect(tableCalls['service_tickets'].some(c => c[0] === 'neq' && c[1] === 'id')).toBe(false);
  });

  it('surfaces returnCount from the returns count query', async () => {
    tableResults['returns'] = { data: null, error: null, count: 2 };

    const { result } = renderHook(() => useDeviceContext('LL01-002'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.returnCount).toBe(2);
    expect(result.current.openTicketCount).toBe(0);
  });

  it('maps unit row fields onto ctx.unit', async () => {
    tableResults['units'] = {
      data: {
        firmware_version: '1.0.0',
        electrical_check: 'pass',
        mechanical_check: 'pass',
        defect_notes: null,
        technician: 'Junaid',
        status_updated_at: '2026-06-01T00:00:00Z',
        test_report_uploaded_at: null,
      },
      error: null,
    };

    const { result } = renderHook(() => useDeviceContext('LL01-003'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.unit?.firmware_version).toBe('1.0.0');
    expect(result.current.unit?.technician).toBe('Junaid');
  });

  it('sets telemetry to null when telemetry project is not configured', async () => {
    const { result } = renderHook(() => useDeviceContext('LL01-004'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.telemetry).toBeNull();
  });
});
