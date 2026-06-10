import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useDeviceContext } from '../service';

// ── Supabase mock ────────────────────────────────────────────────────────────
//
// The hook calls supabase.from(...) for three tables in parallel:
//   units            → .select().eq().maybeSingle()
//   service_tickets  → .select(..., {count:'exact', head:true}).eq().not()  → { count }
//   returns          → .select(..., {count:'exact', head:true}).eq()         → { count }
//
// We key the per-table results on the table name so parallel calls are safe.

type TableResult = { data: unknown; error: unknown; count?: number | null };

const tableResults: Record<string, TableResult> = {};

const makeQueryBuilder = (result: TableResult) => {
  // Every chain method returns a thenable builder.
  // .eq() is BOTH intermediate (units chain: .select().eq().maybeSingle())
  // and terminal (returns chain: .select(...,{head}).eq()  awaited directly).
  // We make .eq() return a Promise that also has chain methods attached,
  // so both uses work.
  const b: Record<string, unknown> = {};

  const makeTerminalPromise = (): Promise<TableResult> & Record<string, unknown> => {
    const p = Promise.resolve(result) as Promise<TableResult> & Record<string, unknown>;
    p.maybeSingle = () => Promise.resolve(result);
    p.not         = () => Promise.resolve(result);
    p.eq          = makeTerminalPromise;
    p.is          = makeTerminalPromise;
    return p;
  };

  b.select      = () => b;
  b.is          = () => b;
  b.not         = () => Promise.resolve(result);    // service_tickets terminal
  b.maybeSingle = () => Promise.resolve(result);    // units terminal
  b.eq          = makeTerminalPromise;              // returns terminal OR intermediate

  return b;
};

vi.mock('../supabase', () => ({
  supabase: {
    from: (table: string) => {
      const result: TableResult = tableResults[table] ?? { data: null, error: null, count: 0 };
      return makeQueryBuilder(result);
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
