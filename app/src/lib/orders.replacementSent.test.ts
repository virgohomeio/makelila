// shipQueuedReplacementsForTicket — the hand-off fired when an operator sets
// "Replacement Sent" on a service ticket. It has to (a) stamp the replacement
// order shipped, (b) land a fulfillment_queue row at step 6, which IS the
// Fulfillment › Queue › SHIPPED list, and (c) never blow up on a replacement
// that carries no serial (parts-only) or a serial that isn't on the shelf.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { fromMock, state } = vi.hoisted(() => {
  const state: {
    linked: any[]; shelf: any[];
    updates: Array<{ table: string; patch: any }>;
    upserts: Array<{ table: string; row: any; opts: any }>;
    linkedError: any; upsertError: any;
  } = { linked: [], shelf: [], updates: [], upserts: [], linkedError: null, upsertError: null };

  // Every PostgREST builder method returns the same awaitable, so a chain of
  // any shape resolves to whatever this table was seeded with.
  const terminal = (result: any): any => {
    const p: any = Promise.resolve(result);
    for (const m of ['eq', 'neq', 'is', 'in', 'select', 'order'] as const) p[m] = () => terminal(result);
    p.single = () => Promise.resolve(result);
    p.maybeSingle = () => Promise.resolve(result);
    return p;
  };

  const fromMock = vi.fn((table: string) => ({
    select: () => terminal(
      table === 'orders'      ? { data: state.linked, error: state.linkedError }
      : table === 'shelf_slots' ? { data: state.shelf, error: null }
      : { data: [], error: null },
    ),
    update: (patch: any) => { state.updates.push({ table, patch }); return terminal({ data: null, error: null }); },
    upsert: (row: any, opts: any) => {
      state.upserts.push({ table, row, opts });
      return terminal({ data: null, error: state.upsertError });
    },
  }));

  return { fromMock, state };
});

vi.mock('./supabase', () => ({
  supabase: {
    from: fromMock,
    auth: { getUser: () => Promise.resolve({ data: { user: { id: 'user-1' } } }) },
    rpc: vi.fn(() => Promise.resolve({ data: null, error: null })),
  },
}));
const logActionMock = vi.fn(() => Promise.resolve());
vi.mock('./activityLog', () => ({ logAction: (...a: unknown[]) => logActionMock(...(a as [])) }));
vi.mock('./parts', () => ({ adjustPartStock: vi.fn(() => Promise.resolve()) }));
vi.mock('./functionError', () => ({ functionErrorMessage: (e: unknown) => String(e) }));

import { shipQueuedReplacementsForTicket } from './orders';

const queueUpsert = () => state.upserts.find(u => u.table === 'fulfillment_queue');

beforeEach(() => {
  vi.clearAllMocks();
  state.updates = []; state.upserts = [];
  state.linkedError = null; state.upsertError = null;
  state.shelf = [{ serial: '00019' }];
  state.linked = [{
    id: 'o-1',
    order_ref: 'R-0042',
    line_items: [{ kind: 'unit', unit_serial: '00019', batch: 'P150', name: 'LILA (P150)', qty: 1, cost_usd: 314 }],
  }];
});

describe('shipQueuedReplacementsForTicket', () => {
  it('stamps the order shipped and lands it in the queue at step 6 (SHIPPED)', async () => {
    const refs = await shipQueuedReplacementsForTicket('t-1');

    expect(refs).toEqual(['R-0042']);
    const orderPatch = state.updates.find(u => u.table === 'orders')?.patch;
    expect(orderPatch).toMatchObject({ status: 'approved' });
    expect(orderPatch.shipped_at).toEqual(expect.any(String));

    expect(queueUpsert()?.row).toMatchObject({
      order_id: 'o-1', step: 6, assigned_serial: '00019',
    });
    expect(queueUpsert()?.row.fulfilled_at).toEqual(expect.any(String));
    // Upsert, not insert: a replacement already part-way through the queue
    // gets promoted rather than colliding on the unique order_id.
    expect(queueUpsert()?.opts).toMatchObject({ onConflict: 'order_id' });
  });

  it('records the shipment against the ticket in the activity log', async () => {
    await shipQueuedReplacementsForTicket('t-1');
    expect(logActionMock).toHaveBeenCalledWith(
      'replacement_shipped', 'R-0042', expect.stringContaining('ticket t-1'),
    );
  });

  it('ships a parts-only replacement with no serial', async () => {
    state.linked = [{
      id: 'o-2', order_ref: 'R-0043',
      line_items: [{ kind: 'part', part_id: 'p-filter', sku: 'LILA-FILTER', name: 'Filter', qty: 2, cost_per_unit_usd: 12 }],
    }];
    await shipQueuedReplacementsForTicket('t-1');
    // Omitted, not null — an omitted column leaves an existing assignment alone.
    expect(queueUpsert()?.row).not.toHaveProperty('assigned_serial');
    expect(queueUpsert()?.row).toMatchObject({ order_id: 'o-2', step: 6 });
  });

  // assigned_serial is FK'd to shelf_slots. A serial that isn't on the shelf
  // would fail the write outright — better to record the shipment without it.
  it('drops a serial that is not on the shelf rather than failing the shipment', async () => {
    state.shelf = [];
    await shipQueuedReplacementsForTicket('t-1');
    expect(queueUpsert()?.row).not.toHaveProperty('assigned_serial');
    expect(queueUpsert()?.row).toMatchObject({ step: 6 });
  });

  it('ships every replacement linked to the ticket', async () => {
    state.linked = [
      { id: 'o-1', order_ref: 'R-0042', line_items: [] },
      { id: 'o-2', order_ref: 'R-0043', line_items: [] },
    ];
    const refs = await shipQueuedReplacementsForTicket('t-1');
    expect(refs).toEqual(['R-0042', 'R-0043']);
    expect(state.upserts.filter(u => u.table === 'fulfillment_queue')).toHaveLength(2);
  });

  // Idempotency comes from the query: already-shipped orders are filtered out
  // server-side, so re-applying the status is a no-op.
  it('writes nothing when the ticket has no live replacement', async () => {
    state.linked = [];
    const refs = await shipQueuedReplacementsForTicket('t-1');
    expect(refs).toEqual([]);
    expect(state.updates).toEqual([]);
    expect(state.upserts).toEqual([]);
  });

  it('throws when the queue write fails, so the operator sees it', async () => {
    state.upsertError = { message: 'rls' };
    await expect(shipQueuedReplacementsForTicket('t-1')).rejects.toThrow(/R-0042.*rls/);
  });

  it('throws when the linked-order lookup fails', async () => {
    state.linkedError = { message: 'boom' };
    await expect(shipQueuedReplacementsForTicket('t-1')).rejects.toThrow(/boom/);
  });
});
