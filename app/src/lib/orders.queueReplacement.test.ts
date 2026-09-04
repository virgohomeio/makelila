// Getting a replacement INTO the fulfillment queue.
//
// Replacements are enqueued at birth now, which covers every replacement
// created from today on. It covers none of the ones that already existed, and
// nothing at all once an order has left the queue again:
//
//   * 43 live replacements predate the change. They sit at status 'pending' or
//     'flagged' with no queue row, and since Sales stopped showing
//     kind='replacement' there is no screen left with a button that queues one.
//   * "Shipment Not Ready — Move Back to Orders" sends a replacement to
//     status 'pending', announcing "Order Review › Replacement" — a tab deleted
//     in 0fb7f45. The order lands nowhere and cannot be queued again.
//
// So the promotion has to exist as its own operation, driven from
// Fulfillment › Replacements, and it has to re-check stock rather than trust
// the replacement_state stamped months ago.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { fromMock, state } = vi.hoisted(() => {
  const state: {
    order: any;
    parts: Record<string, number>;
    units: Record<string, string>;
    updates: Array<{ table: string; patch: any }>;
    inserts: Array<{ table: string; row: any }>;
    queueInsertError: any;
  } = { order: null, parts: {}, units: {}, updates: [], inserts: [], queueInsertError: null };

  // One chainable builder per call. `eq` args are recorded so the resolver can
  // answer per-row lookups (parts.on_hand / units.status) without the test
  // having to know the call order.
  const chain = (resolve: (f: Record<string, any>) => any): any => {
    const filters: Record<string, any> = {};
    const c: any = {};
    for (const m of ['select', 'eq', 'neq', 'is', 'in', 'order', 'limit'] as const) {
      c[m] = (a: any, b: any) => { if (m === 'eq') filters[a] = b; return c; };
    }
    c.single = () => Promise.resolve(resolve(filters));
    c.maybeSingle = () => Promise.resolve(resolve(filters));
    c.then = (ok: any, err: any) => Promise.resolve(resolve(filters)).then(ok, err);
    return c;
  };

  const fromMock = vi.fn((table: string) => ({
    select: (...a: any[]) => {
      const c = chain((f) => {
        if (table === 'orders') return { data: state.order, error: null };
        if (table === 'parts') return { data: { on_hand: state.parts[f.id] ?? 0 }, error: null };
        if (table === 'units') {
          const st = state.units[f.serial];
          return { data: st ? { status: st } : null, error: null };
        }
        return { data: null, error: null };
      });
      return c.select(...a);
    },
    update: (patch: any) => {
      state.updates.push({ table, patch });
      return chain(() => ({ data: null, error: null }));
    },
    insert: (row: any) => {
      state.inserts.push({ table, row });
      return chain(() => ({
        data: null,
        error: table === 'fulfillment_queue' ? state.queueInsertError : null,
      }));
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
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_ANON_KEY: 'anon',
}));
vi.mock('./activityLog', () => ({ logAction: vi.fn(() => Promise.resolve()) }));

import {
  queueReplacementForFulfillment,
  resolveReplacementStockState,
  returnOrderToReview,
} from './orders';

const orderPatch = () => state.updates.find(u => u.table === 'orders')?.patch;
const queued = () => state.inserts.filter(i => i.table === 'fulfillment_queue');

beforeEach(() => {
  state.updates = [];
  state.inserts = [];
  state.queueInsertError = null;
  state.parts = {};
  state.units = {};
  state.order = {
    id: 'o-1', order_ref: 'R-0061', kind: 'replacement', status: 'pending',
    replacement_state: 'ready', linked_ticket_id: 't-467',
    shipped_at: null, delivered_at: null,
    line_items: [{
      kind: 'part', part_id: 'P-LID-V36', sku: 'LILA-LID-V36',
      name: 'Replacement Top Lid (v3.6)', qty: 1, cost_per_unit_usd: 24,
    }],
  };
});

describe('queueReplacementForFulfillment', () => {
  it('approves and enqueues a replacement whose stock is actually on hand', async () => {
    state.parts['P-LID-V36'] = 3;

    const result = await queueReplacementForFulfillment('o-1');

    expect(result).toEqual({ queued: true });
    // 'approved' is what the fulfillment queue lists, and what the existing
    // auto_enqueue_on_approve trigger reacts to.
    expect(orderPatch()).toMatchObject({
      status: 'approved', replacement_state: 'ready', awaiting_batch_id: null,
    });
    expect(queued()).toHaveLength(1);
    expect(queued()[0].row).toMatchObject({ order_id: 'o-1' });
  });

  it('refuses, without writing anything, when the stock is not there', async () => {
    state.parts['P-LID-V36'] = 0;

    const result = await queueReplacementForFulfillment('o-1');

    expect(result.queued).toBe(false);
    // The operator needs to know WHAT is short, not just that something is.
    expect((result as { blocked: string }).blocked).toContain('Replacement Top Lid (v3.6)');
    expect(state.updates).toHaveLength(0);
    expect(queued()).toHaveLength(0);
  });

  it('queues a short order anyway when the operator forces it', async () => {
    state.parts['P-LID-V36'] = 0;

    const result = await queueReplacementForFulfillment('o-1', { force: true });

    expect(result).toEqual({ queued: true });
    expect(orderPatch()).toMatchObject({ status: 'approved' });
    expect(queued()).toHaveLength(1);
  });

  it('treats an existing queue row as success, not as a failure', async () => {
    state.parts['P-LID-V36'] = 3;
    // The status flip fires auto_enqueue_on_approve, so the insert that follows
    // races it and loses on the unique index. That is the trigger doing its job.
    state.queueInsertError = { code: '23505', message: 'duplicate key' };

    await expect(queueReplacementForFulfillment('o-1')).resolves.toEqual({ queued: true });
  });

  it('reserves the unit check against current stock, not the stamped state', async () => {
    // Stamped 'ready' back in June; the serial has since gone out on another
    // order. Trusting replacement_state would queue an order with nothing to put
    // in the box.
    state.order.line_items = [{
      kind: 'unit', unit_serial: 'LP-0042', batch: 'P100', name: 'LILA Pro', qty: 1, cost_usd: 0,
    }];
    state.units['LP-0042'] = 'shipped';

    const result = await queueReplacementForFulfillment('o-1');

    expect(result.queued).toBe(false);
    expect(state.updates).toHaveLength(0);
  });

  it('refuses a replacement that already shipped', async () => {
    state.order.shipped_at = '2026-07-01T00:00:00Z';
    await expect(queueReplacementForFulfillment('o-1')).rejects.toThrow(/already shipped/i);
  });

  it('refuses a cancelled replacement', async () => {
    state.order.status = 'cancelled';
    await expect(queueReplacementForFulfillment('o-1')).rejects.toThrow(/cancelled/i);
  });

  it('refuses a sale — the queue reaches those through Confirm', async () => {
    state.order.kind = 'sale';
    await expect(queueReplacementForFulfillment('o-1')).rejects.toThrow(/not a replacement/i);
  });
});

describe('resolveReplacementStockState', () => {
  it('does not block on a free-text part line that carries no part_id', async () => {
    // The Excel backfill wrote { kind: 'part', description: 'both side latch' }
    // with no part_id. Looking that up returns no row, which read as on_hand 0
    // and marked every legacy replacement short of stock it may well have.
    const stock = await resolveReplacementStockState({
      line_items: [{ kind: 'part', description: 'both side latch' }],
    });

    expect(stock.replacement_state).toBe('ready');
    expect(stock.blocked).toEqual([]);
  });

  it('names each short line', async () => {
    state.parts['P-CHAMBER-L'] = 0;
    const stock = await resolveReplacementStockState({
      line_items: [
        { kind: 'part', part_id: 'P-CHAMBER-L', name: 'Composter Chamber (Left)', qty: 1 },
        { kind: 'unit_pending', batch: 'P100X', name: 'LILA Pro X', qty: 1 },
      ],
    });

    expect(stock.replacement_state).toBe('awaiting');
    expect(stock.awaiting_batch_id).toBe('P100X');
    expect(stock.blocked).toEqual(['Composter Chamber (Left)', 'LILA Pro X']);
  });
});

describe('returnOrderToReview', () => {
  it('sends a replacement to Fulfillment › Replacements, not the deleted Sales tab', async () => {
    state.parts['P-LID-V36'] = 3;

    const landing = await returnOrderToReview('o-1');

    expect(landing.label).toContain('Fulfillment');
    expect(landing.label).toContain('Replacements');
    expect(landing.label).not.toContain('Order Review');
    expect(landing.replacement_state).toBe('ready');
  });

  it('still sends a sale back to Order Review › Pending', async () => {
    state.order.kind = 'sale';
    const landing = await returnOrderToReview('o-1');
    expect(landing.label).toBe('Order Review › Pending');
  });
});
