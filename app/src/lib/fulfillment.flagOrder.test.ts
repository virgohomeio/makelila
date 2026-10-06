// "Flag Order" in the fulfillment queue header.
//
// A packer picks an order up and finds something Sales has to answer before a
// machine goes out — the address is wrong, the line items don't match what was
// paid for, the customer has gone quiet. Cancelling is too final and "Shipment
// Not Ready" drops it back into Pending, where it looks like ordinary work and
// the reason is nowhere on the screen.
//
// Flagging is the third exit: the order leaves the queue, the machine goes back
// on the shelf, and the order lands in Sales › Flagged carrying the note the
// packer typed. These tests hold down that all four of those things happen, and
// that a flag that cannot land honestly fails instead of half-landing.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { fromMock, logMock, addOrderNoteMock, state } = vi.hoisted(() => {
  const state: {
    kind: string;
    step: number;
    fulfilledAt: string | null;
    assignedSerial: string | null;
    links: string[];
    deletedQueueRows: number;
    updateFails: string | null;
    updates: Array<{ table: string; patch: any; match: Record<string, any> }>;
    deletes: Array<{ table: string; match: Record<string, any> }>;
  } = {
    kind: 'sale', step: 2, fulfilledAt: null, assignedSerial: '00019', links: ['00019'],
    deletedQueueRows: 1, updateFails: null, updates: [], deletes: [],
  };

  const chain = (resolve: (f: Record<string, any>) => any): any => {
    const filters: Record<string, any> = {};
    const c: any = {};
    for (const m of ['select', 'in', 'is', 'order', 'limit'] as const) c[m] = () => c;
    c.eq = (col: string, val: any) => { filters[col] = val; return c; };
    c.single = () => Promise.resolve(resolve(filters));
    c.maybeSingle = () => Promise.resolve(resolve(filters));
    c.then = (ok: any, err: any) => Promise.resolve(resolve(filters)).then(ok, err);
    return c;
  };

  const fromMock = vi.fn((table: string) => ({
    select: (...a: any[]) => chain(() => {
      if (table === 'fulfillment_queue') {
        return {
          data: {
            id: 'q-1', order_id: 'o-1', step: state.step,
            assigned_serial: state.assignedSerial, fulfilled_at: state.fulfilledAt,
          },
          error: null,
        };
      }
      if (table === 'orders') {
        return { data: { id: 'o-1', order_ref: '#1209', kind: state.kind }, error: null };
      }
      if (table === 'fulfillment_queue_units') {
        return { data: state.links.map(unit_serial => ({ unit_serial })), error: null };
      }
      if (table === 'units') {
        return { data: { serial: state.assignedSerial, status: 'reserved' }, error: null };
      }
      return { data: null, error: null };
    }).select(...a),
    update: (patch: any) => {
      const c = chain((filters) => {
        state.updates.push({ table, patch, match: filters });
        return table === 'orders' && state.updateFails
          ? { data: null, error: { message: state.updateFails } }
          : { data: null, error: null };
      });
      return c;
    },
    delete: () => {
      const c = chain((filters) => {
        state.deletes.push({ table, match: filters });
        return table === 'fulfillment_queue'
          ? { data: Array(state.deletedQueueRows).fill({ id: 'q-1' }), error: null }
          : { data: null, error: null };
      });
      return c;
    },
    insert: () => chain(() => ({ data: null, error: null })),
  }));

  return {
    fromMock, state,
    logMock: vi.fn(() => Promise.resolve()),
    addOrderNoteMock: vi.fn(() => Promise.resolve()),
  };
});

vi.mock('./supabase', () => ({
  supabase: {
    from: fromMock,
    auth: { getUser: () => Promise.resolve({ data: { user: { id: 'u-1' } } }) },
  },
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_ANON_KEY: 'anon',
}));

vi.mock('./activityLog', () => ({ logAction: logMock }));

vi.mock('./orders', async () => {
  const actual = await vi.importActual<typeof import('./orders')>('./orders');
  return { ...actual, addOrderNote: addOrderNoteMock };
});

import { flagOrderFromQueue } from './fulfillment';

beforeEach(() => {
  Object.assign(state, {
    kind: 'sale', step: 2, fulfilledAt: null, assignedSerial: '00019', links: ['00019'],
    deletedQueueRows: 1, updateFails: null, updates: [], deletes: [],
  });
  logMock.mockClear();
  addOrderNoteMock.mockClear();
});

const orderUpdate = () => state.updates.find(u => u.table === 'orders');

describe('flagOrderFromQueue', () => {
  it('marks the order flagged, which is what puts it in Sales › Flagged', async () => {
    await flagOrderFromQueue('q-1', 'Address is a PO box', 'Huayi');
    expect(orderUpdate()?.patch.status).toBe('flagged');
    expect(orderUpdate()?.match.id).toBe('o-1');
  });

  // bucketOrders drops any order whose customer name matches a shipped unit's.
  // Without this the flag would land the order on a screen that does not list
  // it — the same disappearing act returnOrderToReview documents for #1189.
  it('opens the reconcile outcome so a repeat customer’s order still shows', async () => {
    await flagOrderFromQueue('q-1', 'Needs a new address', 'Huayi');
    expect(orderUpdate()?.patch.reconcile_outcome).toBe('open');
  });

  it('writes the reason where Sales reads it, and to the log', async () => {
    await flagOrderFromQueue('q-1', '  Customer asked to change the colour  ', 'Huayi');
    expect(addOrderNoteMock).toHaveBeenCalledWith(
      'o-1', 'Huayi',
      expect.stringContaining('Customer asked to change the colour'),
    );
    expect(logMock).toHaveBeenCalledWith(
      'fq_order_flagged', '#1209', 'Customer asked to change the colour',
      { entityType: 'order', entityId: 'o-1' },
    );
  });

  it('takes the row out of the queue and gives the machine back', async () => {
    await flagOrderFromQueue('q-1', 'Wrong line items', 'Huayi');
    expect(state.deletes.some(d => d.table === 'fulfillment_queue')).toBe(true);
    expect(state.updates.some(u => u.table === 'units' && u.patch.status === 'ready')).toBe(true);
  });

  it('refuses to flag without a reason — the reason is the whole point', async () => {
    await expect(flagOrderFromQueue('q-1', '   ', 'Huayi')).rejects.toThrow(/reason is required/i);
    expect(state.deletes).toHaveLength(0);
  });

  // A shipped order is flaggable too — "this one that went out has a problem"
  // is a thing an operator needs to be able to say. What it must NOT do is
  // behave like the pre-ship flag: the queue row IS the shipment record, and
  // the machine is at the customer's house.
  describe('on an order that has already shipped', () => {
    beforeEach(() => { state.step = 6; state.fulfilledAt = '2026-10-01T00:00:00Z'; });

    it('flags it', async () => {
      await flagOrderFromQueue('q-1', 'customer says the lid arrived cracked', 'Huayi');
      expect(orderUpdate()?.patch.status).toBe('flagged');
    });

    // Deleting it would throw away fulfilled_at, the tracking number and the
    // carrier — the order would read as never shipped in every rollup that
    // counts step 6.
    it('keeps the queue row, which is the shipment record', async () => {
      await flagOrderFromQueue('q-1', 'arrived cracked', 'Huayi');
      expect(state.deletes.some(d => d.table === 'fulfillment_queue')).toBe(false);
    });

    // The machine is with the customer. Releasing it would put a shipped unit
    // back on the shelf as sellable stock.
    it('leaves the shipped machine alone', async () => {
      await flagOrderFromQueue('q-1', 'arrived cracked', 'Huayi');
      expect(state.updates.some(u => u.table === 'units')).toBe(false);
      expect(state.deletes.some(d => d.table === 'fulfillment_queue_units')).toBe(false);
    });

    it('still records the reason in both places', async () => {
      await flagOrderFromQueue('q-1', 'arrived cracked', 'Huayi');
      expect(addOrderNoteMock).toHaveBeenCalledWith(
        'o-1', 'Huayi', expect.stringContaining('arrived cracked'),
      );
      expect(logMock).toHaveBeenCalledWith(
        'fq_order_flagged', '#1209', 'arrived cracked',
        { entityType: 'order', entityId: 'o-1' },
      );
    });
  });

  // Replacements were refused until bucketOrders grew a keyhole for a flagged
  // one. They flag like any other order now.
  it('flags a replacement, which Sales admits only while it is flagged', async () => {
    state.kind = 'replacement';
    await flagOrderFromQueue('q-1', 'wrong lid colour', 'Huayi');
    expect(orderUpdate()?.patch.status).toBe('flagged');
    expect(state.deletes.some(d => d.table === 'fulfillment_queue')).toBe(true);
  });

  // reconcile_outcome answers a question the Reconcile screen asks of SALES.
  // A replacement is never reconciled, so stamping it would put a sales-ledger
  // value on a row no sales ledger counts.
  it('does not stamp a sales reconcile outcome on a replacement', async () => {
    state.kind = 'replacement';
    await flagOrderFromQueue('q-1', 'wrong lid colour', 'Huayi');
    expect(orderUpdate()?.patch).not.toHaveProperty('reconcile_outcome');
  });

  // The replacement is being stopped, not re-planned. Clearing these would
  // throw away what Fulfillment › Replacements reads to group it, and the
  // re-queue path resolves stock from scratch anyway.
  it('leaves a replacement’s stock planning alone', async () => {
    state.kind = 'replacement';
    await flagOrderFromQueue('q-1', 'wrong lid colour', 'Huayi');
    expect(orderUpdate()?.patch).not.toHaveProperty('replacement_state');
    expect(orderUpdate()?.patch).not.toHaveProperty('awaiting_batch_id');
  });

  it('says so when the order left the queue but would not flag', async () => {
    state.updateFails = 'permission denied';
    await expect(flagOrderFromQueue('q-1', 'bad address', 'Huayi'))
      .rejects.toThrow(/left the queue/i);
  });
});
