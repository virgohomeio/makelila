// What a QC flag at step 2 does to the machines the row was holding.
//
// Flagging used to rewind the row to step 1 and clear assigned_serial, and
// stop there. Everything that made the machines *assigned* survived: the
// fulfillment_queue_units links, the customer name and order ref stamped on
// each unit, and a 'reserved' status on the siblings. Order #1286 went round
// that loop six times — flag, pick another, flag — and ended up on step 1,
// "Assign a ready unit", holding six machines: three in rework, three reserved,
// all six still stamped Aurelia Francisco. Had it ever reached step 6, the
// sync trigger would have marked every one of them shipped to her.
//
// A flag means the machine is Junaid's problem, not the customer's. These
// tests hold down that the row leaves step 2 owning nothing.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { fromMock, state } = vi.hoisted(() => {
  const state: {
    unitStatuses: Record<string, string>;
    links: string[];
    assignedSerial: string | null;
    existingTicket: boolean;
    updates: Array<{ table: string; patch: any; match: Record<string, any> }>;
    inserts: Array<{ table: string; row: any }>;
    deletes: Array<{ table: string; match: Record<string, any> }>;
  } = {
    unitStatuses: {}, links: [], assignedSerial: null, existingTicket: false,
    updates: [], inserts: [], deletes: [],
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
    select: (...a: any[]) => chain((filters) => {
      if (table === 'fulfillment_queue') {
        return { data: { assigned_serial: state.assignedSerial, step: 2 }, error: null };
      }
      if (table === 'fulfillment_queue_units') {
        return {
          data: state.links.map((unit_serial, i) => ({
            unit_serial, assigned_at: `2026-10-0${i + 1}T00:00:00Z`,
          })),
          error: null,
        };
      }
      if (table === 'units' && filters.serial) {
        const status = state.unitStatuses[filters.serial];
        return { data: status ? { serial: filters.serial, status } : null, error: null };
      }
      if (table === 'service_tickets') {
        return { data: state.existingTicket ? { id: 't-1' } : null, error: null };
      }
      return { data: null, error: null };
    }).select(...a),
    insert: (row: any) => {
      state.inserts.push({ table, row });
      // The DB promotes a flagged unit to 'rework' by trigger on this insert.
      if (table === 'build_defects' && row.status === 'in_rework') {
        state.unitStatuses[row.unit_serial] = 'rework';
      }
      return chain(() => ({ data: null, error: null }));
    },
    update: (patch: any) => chain((filters) => {
      state.updates.push({ table, patch, match: filters });
      if (table === 'units' && filters.serial && typeof patch.status === 'string') {
        state.unitStatuses[filters.serial] = patch.status;
      }
      return { data: null, error: null };
    }),
    delete: () => chain((filters) => {
      state.deletes.push({ table, match: filters });
      if (table === 'fulfillment_queue_units') state.links = [];
      return { data: null, error: null };
    }),
  }));

  return { fromMock, state };
});

vi.mock('./supabase', () => ({
  supabase: {
    from: fromMock,
    auth: { getUser: () => Promise.resolve({ data: { user: { id: 'user-1' } } }) },
    rpc: vi.fn(() => Promise.resolve({ data: null, error: null })),
  },
  SUPABASE_URL: 'https://example.test',
  SUPABASE_ANON_KEY: 'anon',
}));
vi.mock('./activityLog', () => ({ logAction: vi.fn(() => Promise.resolve()) }));
vi.mock('./orders', () => ({ cancelOrder: vi.fn(), returnOrderToReview: vi.fn() }));

import { flagRework } from './fulfillment';

const BAD = 'LL01-00000000413';
const SIBLING = 'LL01-00000000414';

const unitPatch = (serial: string) =>
  state.updates.filter(u => u.table === 'units' && u.match.serial === serial).map(u => u.patch);
const queuePatch = () => state.updates.find(u => u.table === 'fulfillment_queue')?.patch;

beforeEach(() => {
  state.unitStatuses = { [BAD]: 'reserved', [SIBLING]: 'reserved' };
  state.links = [BAD, SIBLING];
  state.assignedSerial = BAD;
  state.existingTicket = false;
  state.updates = [];
  state.inserts = [];
  state.deletes = [];
});

describe('flagRework', () => {
  it('stops the flagged machine being owed to the customer', async () => {
    await flagRework('q-1', BAD, 'no test report', 'Huayi');
    // Cleared, but not resold: it stays in rework until the defect is closed.
    expect(unitPatch(BAD)).toContainEqual({ customer_order_ref: null, customer_name: null });
    expect(unitPatch(BAD).some(p => p.status === 'ready')).toBe(false);
  });

  it('puts the machines beside it back into ready stock', async () => {
    await flagRework('q-1', BAD, 'no test report', 'Huayi');
    expect(unitPatch(SIBLING)).toContainEqual({
      status: 'ready', customer_order_ref: null, customer_name: null,
    });
  });

  it('leaves the row owning nothing at all', async () => {
    await flagRework('q-1', BAD, 'no test report', 'Huayi');
    expect(state.deletes).toContainEqual({
      table: 'fulfillment_queue_units', match: { queue_id: 'q-1' },
    });
    expect(queuePatch()).toEqual({ step: 1, assigned_serial: null });
  });

  it('raises the defect and the repair ticket for Junaid', async () => {
    await flagRework('q-1', BAD, 'no test report', 'Huayi');
    expect(state.inserts.find(i => i.table === 'build_defects')!.row).toMatchObject({
      unit_serial: BAD, status: 'in_rework', found_by_name: 'Huayi',
    });
    expect(state.inserts.find(i => i.table === 'service_tickets')!.row).toMatchObject({
      unit_serial: BAD, owner_email: 'junaid@virgohome.io',
    });
  });

  it('works on a row with no child links at all', async () => {
    // A single-unit row on a database that never ran the links migration.
    state.links = [];
    await flagRework('q-1', BAD, 'no test report', 'Huayi');
    expect(unitPatch(BAD)).toContainEqual({ customer_order_ref: null, customer_name: null });
    expect(queuePatch()).toEqual({ step: 1, assigned_serial: null });
  });
});
