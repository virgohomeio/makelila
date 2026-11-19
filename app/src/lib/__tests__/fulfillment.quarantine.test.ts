import { describe, it, expect, vi, beforeEach } from 'vitest';

// Table-aware supabase mock. assignUnits reads every picked unit in ONE query
// (`.in('serial', …)`) rather than one `.single()` per serial, so the chain
// here resolves on await as well as on .single().
/* eslint-disable @typescript-eslint/no-explicit-any */
const { fromMock, unitStatus, inserted } = vi.hoisted(() => {
  const unitStatus: { value: string } = { value: 'ready' };
  const inserted: Array<{ table: string; rows: any }> = [];

  const chain = (resolve: () => any): any => {
    const c: any = {};
    for (const m of ['select', 'eq', 'in', 'is', 'order', 'limit'] as const) {
      c[m] = () => c;
    }
    c.single = () => Promise.resolve(resolve());
    c.maybeSingle = () => Promise.resolve(resolve());
    c.then = (ok: any, err: any) => Promise.resolve(resolve()).then(ok, err);
    return c;
  };

  const fromMock = vi.fn((table: string) => ({
    select: (...a: any[]) => chain(() => {
      if (table === 'orders') {
        return { data: { order_ref: '#TEST-001', customer_name: 'Test Customer' }, error: null };
      }
      if (table === 'units') {
        // The one-query read: a list, keyed by serial.
        return { data: [{ serial: 'LL01-TEST-001', status: unitStatus.value }], error: null };
      }
      // fulfillment_queue_units: no prior assignments on this row.
      return { data: [], error: null };
    }).select(...a),
    update: () => chain(() => ({ data: null, error: null })),
    upsert: (rows: any) => {
      inserted.push({ table, rows });
      return chain(() => ({ data: null, error: null }));
    },
    delete: () => chain(() => ({ data: null, error: null })),
  }));

  return { fromMock, unitStatus, inserted };
});

vi.mock('../supabase', () => ({
  supabase: {
    from: fromMock,
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } } }) },
  },
}));
vi.mock('../activityLog', () => ({ logAction: vi.fn().mockResolvedValue(undefined) }));

import { assignUnit, assignUnits } from '../fulfillment';

describe('assignUnit — pickable guard', () => {
  beforeEach(() => {
    fromMock.mockClear();
    inserted.length = 0;
    unitStatus.value = 'ready';
  });

  it('throws when the target unit is quarantined', async () => {
    unitStatus.value = 'quarantine';
    await expect(assignUnit('queue-1', 'LL01-TEST-001', 'order-1')).rejects.toThrow(
      /cannot be assigned/i,
    );
  });

  it('throws when the target unit is in team-test', async () => {
    unitStatus.value = 'team-test';
    await expect(assignUnit('queue-1', 'LL01-TEST-001', 'order-1')).rejects.toThrow(
      /cannot be assigned/i,
    );
  });

  it('does not throw for a ready unit', async () => {
    unitStatus.value = 'ready';
    await expect(assignUnit('queue-1', 'LL01-TEST-001', 'order-1')).resolves.not.toThrow();
  });

  it('does not throw for a shipped (backfill) unit', async () => {
    unitStatus.value = 'shipped';
    await expect(assignUnit('queue-1', 'LL01-TEST-001', 'order-1')).resolves.not.toThrow();
  });

  it('refuses the whole pick when ONE unit of several is unpickable', async () => {
    // The guard runs over every serial before anything is written, so a bad
    // unit in a three-machine pick cannot leave the other two reserved
    // against a row that never advanced.
    unitStatus.value = 'quarantine';
    await expect(
      assignUnits('queue-1', ['LL01-TEST-001', 'LL01-TEST-002'], 'order-1'),
    ).rejects.toThrow(/cannot be assigned/i);
    expect(inserted).toHaveLength(0);
  });

  it('rejects an empty pick', async () => {
    await expect(assignUnits('queue-1', [], 'order-1')).rejects.toThrow(/at least one unit/i);
  });
});
