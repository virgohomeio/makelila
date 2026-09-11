// Releasing a hold is the way back out of the Held tab, and until it existed
// the only exits were Confirm (gated on the pre-ship checks, and it ships the
// order) or an UPDATE run by hand against the database.
//
// The case that forced it: #1214 was confirmed by mistake and held 40 seconds
// later. The confirm had already fired auto_enqueue_approved_order, and the
// hold withdrew nothing — so the order sat Held in Sales and step-1
// Ready-to-ship in Fulfillment simultaneously for 29 days. A release therefore
// has to move the order AND pull the row, or it just relocates the hazard.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { fromMock, state, logMock } = vi.hoisted(() => {
  const state: {
    queue: any; order: any; unit: any;
    deletes: string[]; updates: Array<{ table: string; patch: any }>;
  } = { queue: null, order: null, unit: null, deletes: [], updates: [] };

  const terminal = (result: any): any => {
    const p: any = Promise.resolve(result);
    for (const m of ['eq', 'is', 'in', 'select', 'order'] as const) p[m] = () => terminal(result);
    p.single = () => Promise.resolve(result);
    p.maybeSingle = () => Promise.resolve(result);
    return p;
  };

  const rowFor = (table: string) =>
    table === 'fulfillment_queue' ? state.queue
    : table === 'orders'         ? state.order
    : table === 'units'          ? state.unit
    : null;

  const fromMock = vi.fn((table: string) => ({
    select: () => terminal({ data: rowFor(table), error: null }),
    delete: () => { state.deletes.push(table); return terminal({ data: [{ id: 'q-1' }], error: null }); },
    update: (patch: any) => { state.updates.push({ table, patch }); return terminal({ data: null, error: null }); },
    insert: () => terminal({ data: null, error: null }),
  }));

  const logMock = vi.fn(() => Promise.resolve());
  return { fromMock, state, logMock };
});

vi.mock('./supabase', () => ({
  supabase: {
    from: fromMock,
    auth: { getUser: () => Promise.resolve({ data: { user: { id: 'user-1' } } }) },
    rpc: vi.fn(() => Promise.resolve({ data: null, error: null })),
  },
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_ANON_KEY: 'anon',
}));
vi.mock('./activityLog', () => ({ logAction: logMock }));

import { releaseHold } from './fulfillment';

const patchFor = (table: string) => state.updates.find(u => u.table === table)?.patch;

beforeEach(() => {
  state.deletes = []; state.updates = []; logMock.mockClear();
  state.queue = { id: 'q-1', order_id: 'o-1', step: 1, assigned_serial: '00019', fulfilled_at: null };
  state.order = {
    id: 'o-1', order_ref: '#1214', kind: 'sale', status: 'held',
    replacement_state: null, line_items: [],
  };
  state.unit = { status: 'reserved' };
});

describe('releaseHold', () => {
  it('sends the order back to Pending and pulls the queue row the mis-click left', async () => {
    const result = await releaseHold('o-1');

    expect(state.deletes).toContain('fulfillment_queue');
    expect(result.queueRowRemoved).toBe(true);

    // The machine must not stay reserved for an order that is back in review.
    expect(patchFor('units')).toMatchObject({ status: 'ready', customer_order_ref: null });
    expect(patchFor('shelf_slots')).toMatchObject({ status: 'available' });
    expect(result.releasedSerial).toBe('00019');

    // Pending is the intake state, so the hold's disposition stamps go with it —
    // and it lands in the same UPDATE as the status, not a second write.
    expect(patchFor('orders')).toMatchObject({
      status: 'pending', dispositioned_by: null, dispositioned_at: null,
    });
    expect(state.updates.filter(u => u.table === 'orders')).toHaveLength(1);

    expect(result.landing.label).toBe('Order Review › Pending');
    expect(logMock).toHaveBeenCalledWith('order_hold_released', '#1214', 'Order Review › Pending');
  });

  it('releases a hold that never had a queue row', async () => {
    state.queue = null;

    const result = await releaseHold('o-1');

    expect(result.queueRowRemoved).toBe(false);
    expect(result.releasedSerial).toBeNull();
    expect(state.deletes).not.toContain('fulfillment_queue');
    expect(patchFor('orders')).toMatchObject({ status: 'pending' });
  });

  it('reports no released serial when the unit was never reserved', async () => {
    state.unit = { status: 'shipped' };

    const result = await releaseHold('o-1');

    expect(result.queueRowRemoved).toBe(true);
    // The row went, but nothing was returned to stock — the banner must not
    // claim a machine came back that never left.
    expect(result.releasedSerial).toBeNull();
    expect(patchFor('units')).toBeUndefined();
  });

  it('refuses an order that has already shipped, and changes nothing', async () => {
    state.queue = { ...state.queue, step: 6, fulfilled_at: '2026-08-20T00:00:00Z' };

    await expect(releaseHold('o-1')).rejects.toThrow(/already shipped/);

    expect(state.deletes).toEqual([]);
    expect(state.updates).toEqual([]);
    expect(logMock).not.toHaveBeenCalled();
  });

  it('refuses an order that is not on hold', async () => {
    state.order = { ...state.order, status: 'approved' };

    await expect(releaseHold('o-1')).rejects.toThrow(/not on hold/);

    expect(state.deletes).toEqual([]);
    expect(state.updates).toEqual([]);
  });
});
