// An order that never came from Shopify.
//
// Everything in Sales arrives through sync-shopify-orders or the invoice
// importer, so a sale agreed on the phone, at a trade show or over email had no
// way into the app at all. The operator's only options were to ask the customer
// to place a web order they had already paid for, or to ship the machine off
// the books entirely — which is how units end up shipped with no order row and
// land in the reconcile screen months later.
//
// The whole point is that the row is ordinary afterwards. These tests pin the
// handful of fields that decide that, because each one has a way of going
// quietly wrong: an order that is invisible in every tab, or one that confirms
// without the pre-ship checks ever running.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { fromMock, state } = vi.hoisted(() => {
  const state: {
    existingRefs: string[];
    inserts: Array<{ table: string; row: any }>;
    /** Errors to return from successive orders INSERTs, oldest first. Lets a
     *  test drive the unique-violation retry. */
    insertErrors: Array<any>;
  } = { existingRefs: [], inserts: [], insertErrors: [] };

  const chain = (resolve: () => any): any => {
    const c: any = {};
    for (const m of ['select', 'eq', 'like', 'ilike', 'order', 'limit', 'is'] as const) {
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
        return { data: state.existingRefs.map(order_ref => ({ order_ref })), error: null };
      }
      return { data: [], error: null };
    }).select(...a),
    insert: (row: any) => {
      state.inserts.push({ table, row });
      const error = state.insertErrors.shift() ?? null;
      return chain(() => ({
        data: error ? null : { id: 'new-order-1', order_ref: row.order_ref, status: row.status },
        error,
      }));
    },
  }));

  return { fromMock, state };
});

vi.mock('./supabase', () => ({
  supabase: {
    from: fromMock,
    auth: { getUser: () => Promise.resolve({ data: { user: { id: 'user-1', email: 'huayi@virgohome.io' } } }) },
    rpc: vi.fn(() => Promise.resolve({ data: null, error: null })),
  },
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_ANON_KEY: 'anon',
}));
vi.mock('./activityLog', () => ({ logAction: vi.fn(() => Promise.resolve()) }));

import { createManualOrder, nextManualOrderRef, manualOrderTotals, type ManualOrderInput } from './orders';
import { freightQuoted } from '../modules/OrderReview/detail/ReadinessChecklist';
import { bucketOrders, type Order } from './orders';
import { logAction } from './activityLog';

const orderInsert = () => state.inserts.find(i => i.table === 'orders')?.row;

const input = (over: Partial<ManualOrderInput> = {}): ManualOrderInput => ({
  customer_name: 'Dana Whitfield',
  customer_email: 'dana@example.com',
  customer_phone: '+14165550123',
  address: {
    address_line: '88 Palmerston Ave',
    address_line2: null,
    city: 'Toronto',
    region_state: 'ON',
    country: 'CA',
    postal_code: 'M6J 2J2',
  },
  currency: 'CAD',
  line_items: [{ name: 'LILA Pro', sku: 'LILA-PRO-WHITE', qty: 1, price_usd: 2499 }],
  financial_status: 'paid',
  placed_at: '2026-10-01T15:00:00.000Z',
  note: 'Sold at the Evergreen Brick Works market',
  ...over,
});

beforeEach(() => {
  state.existingRefs = [];
  state.inserts = [];
  state.insertErrors = [];
  vi.mocked(logAction).mockClear();
});

describe('nextManualOrderRef', () => {
  it('starts the series at M-0001', async () => {
    expect(await nextManualOrderRef()).toBe('M-0001');
  });

  it('counts from the highest existing M- ref, numerically', async () => {
    // Lexicographic max would pick M-0009 over M-0010.
    state.existingRefs = ['M-0001', 'M-0009', 'M-0010'];
    expect(await nextManualOrderRef()).toBe('M-0011');
  });

  it('ignores refs from the other three series', async () => {
    // Shopify's '#' series, the invoice importer's INV- and replacements' R-
    // are independent sequences — see the order_ref note in this module.
    state.existingRefs = ['#1284', 'INV-R1205', 'R-0070', 'M-0003'];
    expect(await nextManualOrderRef()).toBe('M-0004');
  });

  it('ignores an M- ref that is not the plain numeric shape', async () => {
    state.existingRefs = ['M-0002', 'M-TRADESHOW'];
    expect(await nextManualOrderRef()).toBe('M-0003');
  });
});

describe('manualOrderTotals', () => {
  it('sums qty × price across the lines', () => {
    expect(manualOrderTotals([
      { name: 'LILA Pro', sku: '', qty: 2, price_usd: 2499 },
      { name: 'Spare lid', sku: '', qty: 1, price_usd: 49.5 },
    ])).toEqual({ subtotal: 5047.5, units: 3 });
  });

  it('is zero for no lines', () => {
    expect(manualOrderTotals([])).toEqual({ subtotal: 0, units: 0 });
  });
});

describe('createManualOrder', () => {
  it('creates an ordinary pending sale', async () => {
    const result = await createManualOrder(input());

    expect(result).toMatchObject({ id: 'new-order-1', order_ref: 'M-0001' });
    const row = orderInsert();
    // kind 'sale' is what puts it in Sales at all — bucketOrders drops every
    // kind='replacement' row before it builds a single tab.
    expect(row.kind).toBe('sale');
    // NOT 'approved'. auto_enqueue_on_approve is an UPDATE-only trigger, so
    // confirming the order is what queues it — the same gate a synced order
    // goes through. Birthing it approved would skip Verify + quote entirely.
    expect(row.status).toBe('pending');
    expect(row.replacement_state).toBeUndefined();
    expect(row.linked_ticket_id).toBeUndefined();
  });

  it('leaves the pre-ship gate unsatisfied', async () => {
    await createManualOrder(input());
    const row = orderInsert();

    // freightQuoted() reads 'manual' + a non-zero estimate as "a carrier rate
    // was pulled". A hand-typed order has had no rate pulled, so the estimate
    // has to be 0 or the third confirm criterion passes on a quote that never
    // ran. This is why the form has no freight field.
    expect(row.freight_estimate_usd).toBe(0);
    expect(freightQuoted({ ...row, freight_estimate_usd: 0 } as unknown as Order)).toBe(false);
    // Nothing has verified this address either.
    expect(row.address_verified_at).toBeUndefined();
    expect(row.address_verdict_source).toBe('sync-guess');
    expect(row.freight_threshold_usd).toBe(200);
  });

  it('stays visible in Sales for a customer who already has a unit', async () => {
    await createManualOrder(input());
    const row = orderInsert();

    // bucketOrders hides any order whose customer name matches a shipped
    // unit's — 112 of 163 pending orders at one point. For a row created by
    // hand ten seconds ago that heuristic is always wrong, and 'open' is the
    // documented override (see recordStillOpen in lib/reconcile.ts).
    expect(row.reconcile_outcome).toBe('open');
    expect(row.reconciled_by).toBe('huayi@virgohome.io');

    const order = {
      ...row,
      id: 'new-order-1',
      customer_name: 'Dana Whitfield',
      created_at: row.placed_at,
    } as unknown as Order;
    const buckets = bucketOrders(
      [order],
      new Set<string>(),
      new Set(['dana whitfield']),  // she has a shipped unit from an earlier order
    );
    expect(buckets.pending.map(o => o.id)).toEqual(['new-order-1']);
  });

  it('leaves cogs_usd to the schedule trigger', async () => {
    await createManualOrder(input());
    // orders_set_sale_cogs fills cogs_usd + cogs_basis on INSERT whenever it is
    // null. Sending a 0 would read as a free machine in every margin rollup.
    expect(orderInsert().cogs_usd).toBeUndefined();
  });

  it('records the money the operator typed', async () => {
    await createManualOrder(input({
      line_items: [{ name: 'LILA Pro', sku: '', qty: 2, price_usd: 2000 }],
      currency: 'USD',
      financial_status: 'pending',
    }));
    const row = orderInsert();

    expect(row).toMatchObject({
      currency: 'USD',
      subtotal_usd: 4000,
      total_usd: 4000,
      financial_status: 'pending',
    });
    // 'refunded' and 'voided' are the two states that hold an order out of the
    // Pending queue. A manual order is never born in either.
    expect(['refunded', 'voided']).not.toContain(row.financial_status);
  });

  it('dates the order so it is inside the Sales window', async () => {
    await createManualOrder(input());
    // Every Sales tab starts at SALES_QUEUE_START; an order placed before it is
    // in no bucket at all.
    expect(orderInsert().placed_at).toBe('2026-10-01T15:00:00.000Z');
  });

  it('retries with the next ref when the ref is taken', async () => {
    // Two operators creating an order at once both read the same max. The
    // UNIQUE constraint on order_ref is the real serializer, so a 23505 is a
    // signal to take the next number, not an error to show anybody.
    state.insertErrors = [{ code: '23505', message: 'duplicate key value violates unique constraint "orders_order_ref_key"' }];

    const result = await createManualOrder(input());

    expect(result.order_ref).toBe('M-0002');
    expect(state.inserts.filter(i => i.table === 'orders')).toHaveLength(2);
  });

  it('gives up after repeated ref collisions rather than looping', async () => {
    state.insertErrors = Array.from({ length: 10 }, () => ({ code: '23505', message: 'dup' }));
    await expect(createManualOrder(input())).rejects.toThrow(/order reference/i);
  });

  it('surfaces a real insert failure', async () => {
    state.insertErrors = [{ code: '23502', message: 'null value in column "city"' }];
    await expect(createManualOrder(input())).rejects.toThrow(/city/);
  });

  it('logs the creation against the order', async () => {
    await createManualOrder(input());
    expect(logAction).toHaveBeenCalledWith(
      'order_manual_create',
      'M-0001',
      expect.stringContaining('Dana Whitfield'),
      { entityType: 'order', entityId: 'new-order-1' },
    );
  });

  it('carries the operator note through as the first order note', async () => {
    await createManualOrder(input());
    const note = state.inserts.find(i => i.table === 'order_notes');
    expect(note?.row).toMatchObject({
      order_id: 'new-order-1',
      body: 'Sold at the Evergreen Brick Works market',
    });
  });

  it('writes no note when the operator left it blank', async () => {
    await createManualOrder(input({ note: '   ' }));
    expect(state.inserts.find(i => i.table === 'order_notes')).toBeUndefined();
  });

  describe('validation', () => {
    const cases: Array<[string, Partial<ManualOrderInput>, RegExp]> = [
      ['a blank customer name', { customer_name: '  ' }, /customer name/i],
      ['no line items', { line_items: [] }, /line item/i],
      ['a line with no name', { line_items: [{ name: ' ', sku: '', qty: 1, price_usd: 10 }] }, /product name/i],
      ['a zero quantity', { line_items: [{ name: 'LILA Pro', sku: '', qty: 0, price_usd: 10 }] }, /quantity/i],
      ['a negative price', { line_items: [{ name: 'LILA Pro', sku: '', qty: 1, price_usd: -5 }] }, /price/i],
    ];

    it.each(cases)('rejects %s', async (_label, over, message) => {
      await expect(createManualOrder(input(over))).rejects.toThrow(message);
      expect(state.inserts).toHaveLength(0);
    });

    it('rejects a blank city, which the row cannot be null', async () => {
      await expect(createManualOrder(input({
        address: { ...input().address, city: '' },
      }))).rejects.toThrow(/city/i);
    });
  });
});
