// Rebooking a shipment whose carrier booking and pickup were cancelled.
//
// The row has to come back to step 3 with the booking erased, the machines have
// to stop claiming they shipped, and the Goorooship email that announced the
// cancelled collection has to stop holding the row in "To be picked up".
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { fromMock, logMock, state } = vi.hoisted(() => {
  const state: {
    queue: any; order: any; units: any[]; queueUnits: any[] | null;
    updates: Array<{ table: string; patch: any }>;
    /** Message the next fulfillment_queue update should fail with, once. */
    queueUpdateError: string | null;
  } = {
    queue: null, order: null, units: [], queueUnits: null,
    updates: [], queueUpdateError: null,
  };

  const terminal = (result: any): any => {
    const p: any = Promise.resolve(result);
    for (const m of ['eq', 'is', 'in', 'select', 'order'] as const) p[m] = () => terminal(result);
    p.single = () => Promise.resolve(result);
    p.maybeSingle = () => Promise.resolve(result);
    return p;
  };

  const rowsFor = (table: string) =>
    table === 'fulfillment_queue'       ? state.queue
    : table === 'orders'                ? state.order
    : table === 'units'                 ? state.units
    : table === 'fulfillment_queue_units' ? state.queueUnits
    : null;

  const fromMock = vi.fn((table: string) => ({
    select: () => {
      if (table === 'fulfillment_queue_units' && state.queueUnits === null) {
        // The child table isn't there — a database that has not run
        // 20261001130000 yet. PostgREST's undefined_table.
        return terminal({ data: null, error: { code: '42P01', message: 'relation does not exist' } });
      }
      return terminal({ data: rowsFor(table), error: null });
    },
    update: (patch: any) => {
      if (table === 'fulfillment_queue' && state.queueUpdateError) {
        const message = state.queueUpdateError;
        state.queueUpdateError = null;
        return terminal({ data: null, error: { message } });
      }
      state.updates.push({ table, patch });
      return terminal({ data: null, error: null });
    },
  }));

  const logMock = vi.fn(() => Promise.resolve());
  return { fromMock, logMock, state };
});

vi.mock('./supabase', () => ({
  supabase: {
    from: fromMock,
    auth: { getUser: () => Promise.resolve({ data: { user: { id: 'user-1' } } }) },
  },
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_ANON_KEY: 'anon',
}));
vi.mock('./activityLog', () => ({ logAction: logMock }));

import { canRebookShipment, rebookShipment, REBOOK_ACTION } from './rebookShipment';

const patchesFor = (table: string) => state.updates.filter(u => u.table === table).map(u => u.patch);
const patchFor = (table: string) => patchesFor(table)[0];

beforeEach(() => {
  state.updates = [];
  state.queueUpdateError = null;
  state.queue = {
    id: 'q-1', order_id: 'o-1', step: 6, assigned_serial: 'LL01-00000000355',
    carrier: 'Canpar', tracking_num: 'D420000112',
  };
  state.order = { id: 'o-1', order_ref: '#1189', kind: 'sale' };
  state.units = [{ serial: 'LL01-00000000355', status: 'shipped', backfilled_at: null }];
  state.queueUnits = [{ unit_serial: 'LL01-00000000355', assigned_at: '2026-10-01T00:00:00Z' }];
  logMock.mockClear();
});

describe('canRebookShipment', () => {
  it('is offered from the dock handoff onwards, where a booking exists', () => {
    expect(canRebookShipment({ step: 4 })).toBe(true);
    expect(canRebookShipment({ step: 5 })).toBe(true);
    expect(canRebookShipment({ step: 6 })).toBe(true);
  });

  it('is not offered at or before the label step — there is nothing booked yet', () => {
    expect(canRebookShipment({ step: 1 })).toBe(false);
    expect(canRebookShipment({ step: 2 })).toBe(false);
    expect(canRebookShipment({ step: 3 })).toBe(false);
  });
});

describe('rebookShipment', () => {
  it('returns the row to the label step with the cancelled booking erased', async () => {
    await rebookShipment('q-1');

    expect(patchFor('fulfillment_queue')).toMatchObject({
      step: 3,
      carrier: null,
      tracking_num: null,
      label_pdf_path: null,
      label_confirmed_at: null,
      dock_printed: false,
      dock_affixed: false,
      dock_docked: false,
      dock_notified: false,
      dock_picked_up: false,
      dock_confirmed_at: null,
      // Both emails can be sent again, with the number of the new booking.
      email_sent_at: null,
      fulfilled_at: null,
      eztrans_confirmed_at: null,
      eztrans_batch_sent_at: null,
    });
  });

  it('keeps the pick and the test report — only the booking was cancelled', async () => {
    await rebookShipment('q-1');
    const patch = patchFor('fulfillment_queue');
    expect(patch).not.toHaveProperty('assigned_serial');
    expect(patch).not.toHaveProperty('test_confirmed_at');
    expect(patch).not.toHaveProperty('test_report_url');
    // The US compost starter ships from Amazon on its own label, which nobody
    // cancelled.
    expect(patch).not.toHaveProperty('starter_tracking_num');
  });

  it('takes the machines back off shipped and reserves them against the order', async () => {
    const done = await rebookShipment('q-1');

    expect(patchFor('units')).toEqual({ status: 'reserved', shipped_at: null });
    expect(patchFor('shelf_slots')).toMatchObject({ status: 'reserved' });
    expect(done.restored).toEqual(['LL01-00000000355']);
  });

  it('leaves a machine alone that was already shipped when it was paired', async () => {
    // Backlog #57's backfill: the unit shipped months before this row existed,
    // so its 'shipped' status is not this booking's doing.
    state.units = [{ serial: 'LL01-00000000355', status: 'shipped', backfilled_at: '2026-06-05T00:00:00Z' }];
    const done = await rebookShipment('q-1');

    expect(patchesFor('units')).toEqual([]);
    expect(done.restored).toEqual([]);
  });

  it('says the order still owes the customer a machine, so it stays off the shipped rail', async () => {
    await rebookShipment('q-1');
    expect(patchFor('orders')).toEqual({ reconcile_outcome: 'open' });
  });

  it('leaves a replacement order alone — its ticket decides, not this verdict', async () => {
    state.order = { id: 'o-1', order_ref: 'R-0069', kind: 'replacement' };
    await rebookShipment('q-1');
    expect(patchesFor('orders')).toEqual([]);
  });

  it('logs the rebook against the ORDER, which is what retires the Goorooship send', async () => {
    await rebookShipment('q-1', 'pickup cancelled, rebooking with GLS');

    const [type, entity, detail, refs] = logMock.mock.calls[0] as unknown as
      [string, string, string, Record<string, unknown>];
    expect(type).toBe(REBOOK_ACTION);
    expect(entity).toBe('#1189');
    expect(refs).toMatchObject({ entityType: 'order', entityId: 'o-1' });
    // The number the carrier voided is the thing someone reading this later
    // needs; it is about to be wiped off the row.
    expect(detail).toContain('Canpar · D420000112');
    expect(detail).toContain('pickup cancelled, rebooking with GLS');
  });

  it('refuses a row that has no booking to redo', async () => {
    state.queue = { ...state.queue, step: 3 };
    await expect(rebookShipment('q-1')).rejects.toThrow(/already at the label step/i);
    expect(state.updates).toEqual([]);
  });

  it('retries without the day-batch columns on a database that lacks them', async () => {
    state.queueUpdateError = "column fulfillment_queue.eztrans_batch_sent_at does not exist";
    await rebookShipment('q-1');

    const patch = patchFor('fulfillment_queue');
    expect(patch).toMatchObject({ step: 3, carrier: null, fulfilled_at: null });
    expect(patch).not.toHaveProperty('eztrans_batch_sent_at');
  });

  it('writes nothing else when the queue row cannot be cleared', async () => {
    state.queueUpdateError = 'permission denied for table fulfillment_queue';
    await expect(rebookShipment('q-1')).rejects.toThrow(/could not clear the booking/i);
    expect(state.updates).toEqual([]);
    expect(logMock).not.toHaveBeenCalled();
  });

  it('still frees the one machine it knows about without the child table', async () => {
    state.queueUnits = null;
    const done = await rebookShipment('q-1');
    expect(done.restored).toEqual(['LL01-00000000355']);
  });
});
