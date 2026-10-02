// Three machines on one order.
//
// fulfillment_queue.assigned_serial holds one serial, so step 1 could only ever
// reserve one machine however many the order was for. M-0001 (James San Roman,
// three LILA Pros) is the order that found it: one unit was picked, the row
// advanced, and the other two stayed sellable with nothing recording that they
// were owed to anybody.
//
// What these tests hold down is the set — that every picked machine is
// reserved, that assigned_serial still names one of them for the dozen older
// reads built on it, and that a pick which cannot be recorded reserves nothing
// at all.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { fromMock, state } = vi.hoisted(() => {
  const state: {
    unitStatuses: Record<string, string>;
    /** Child rows already on the row, oldest first. */
    existingLinks: string[];
    /** The step the queue row is sitting on when the assignment comes in. */
    queueStep: number;
    /** Error the fulfillment_queue_units write returns, if any. */
    linkError: any;
    upserts: Array<{ table: string; rows: any }>;
    updates: Array<{ table: string; patch: any; match: Record<string, any> }>;
    deletes: Array<{ table: string; match: Record<string, any> }>;
  } = {
    unitStatuses: {}, existingLinks: [], queueStep: 1, linkError: null,
    upserts: [], updates: [], deletes: [],
  };

  const chain = (resolve: (f: Record<string, any>) => any): any => {
    const filters: Record<string, any> = {};
    const c: any = {};
    for (const m of ['select', 'in', 'is', 'order', 'limit'] as const) {
      c[m] = () => c;
    }
    c.eq = (col: string, val: any) => { filters[col] = val; return c; };
    c.single = () => Promise.resolve(resolve(filters));
    c.maybeSingle = () => Promise.resolve(resolve(filters));
    c.then = (ok: any, err: any) => Promise.resolve(resolve(filters)).then(ok, err);
    return c;
  };

  const fromMock = vi.fn((table: string) => ({
    select: (...a: any[]) => chain((filters) => {
      if (table === 'orders') {
        return { data: { order_ref: 'M-0001', customer_name: 'James San Roman' }, error: null };
      }
      if (table === 'fulfillment_queue') {
        return { data: { step: state.queueStep, assigned_serial: state.existingLinks[0] ?? null }, error: null };
      }
      if (table === 'units') {
        // A single-serial read (the release path) resolves to that one row.
        if (filters.serial) {
          const status = state.unitStatuses[filters.serial];
          return { data: status ? { serial: filters.serial, status } : null, error: null };
        }
        return {
          data: Object.entries(state.unitStatuses).map(([serial, status]) => ({ serial, status })),
          error: null,
        };
      }
      if (table === 'fulfillment_queue_units') {
        // Only a missing table fails the READ as well — a constraint violation
        // is something the upsert reports, not the select.
        if (state.linkError?.code === '42P01') return { data: null, error: state.linkError };
        return {
          data: state.existingLinks.map((unit_serial, i) => ({
            unit_serial, assigned_at: `2026-10-0${i + 1}T00:00:00Z`,
          })),
          error: null,
        };
      }
      return { data: null, error: null };
    }).select(...a),
    upsert: (rows: any) => {
      if (!state.linkError) state.upserts.push({ table, rows });
      return chain(() => ({ data: null, error: state.linkError }));
    },
    update: (patch: any) => {
      const c = chain((filters) => {
        state.updates.push({ table, patch, match: filters });
        // Keep the fake units table honest: a release really does change the
        // status the next read sees, and the pickable check depends on it.
        if (table === 'units' && filters.serial && typeof patch.status === 'string') {
          state.unitStatuses[filters.serial] = patch.status;
        }
        return { data: null, error: null };
      });
      return c;
    },
    delete: () => chain((filters) => {
      state.deletes.push({ table, match: filters });
      // The links really are gone afterwards, so the re-read that picks
      // assigned_serial sees an empty row.
      if (table === 'fulfillment_queue_units') state.existingLinks = [];
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

import { assignUnits, orderUnitTarget } from './fulfillment';
import { logAction } from './activityLog';

const THREE = ['LL01-0001', 'LL01-0002', 'LL01-0003'];

const unitPatches = () => state.updates.filter(u => u.table === 'units');
const slotPatches = () => state.updates.filter(u => u.table === 'shelf_slots');
const queuePatch = () => state.updates.find(u => u.table === 'fulfillment_queue')?.patch;
const linkRows = () => state.upserts.find(u => u.table === 'fulfillment_queue_units')?.rows ?? [];

beforeEach(() => {
  state.unitStatuses = Object.fromEntries(THREE.map(s => [s, 'ready']));
  state.existingLinks = [];
  state.queueStep = 1;
  state.linkError = null;
  state.upserts = [];
  state.updates = [];
  state.deletes = [];
  vi.mocked(logAction).mockClear();
});

describe('orderUnitTarget', () => {
  it('counts the quantity on a sale line', () => {
    expect(orderUnitTarget([{ sku: '', name: 'LILA Pro', qty: 3, price_usd: 0 }])).toBe(3);
  });

  it('ignores a sale line that is not a machine', () => {
    // A real order carries this line beside the machine.
    expect(orderUnitTarget([
      { sku: '', name: 'LILA Pro', qty: 1, price_usd: 2499 },
      { sku: '', name: 'Unlock 30% Off in Cart', qty: 1, price_usd: 0 },
    ])).toBe(1);
  });

  it('counts replacement unit and base lines, not parts', () => {
    expect(orderUnitTarget([
      { kind: 'unit', unit_serial: 'x', batch: 'P100', name: 'LILA Pro', qty: 1, cost_usd: 300 },
      { kind: 'base', unit_serial: 'y', batch: 'BASE1', name: 'Base', qty: 1, cost_usd: 100 },
      { kind: 'part', part_id: 'P-LID', sku: 'LID', name: 'Lid', qty: 2, cost_per_unit_usd: 24 },
    ])).toBe(2);
  });

  it('falls back to one rather than zero', () => {
    // Never 0: "assign at least one" is true of every order that gets here,
    // and a 0 target would read as "this order needs no machines".
    expect(orderUnitTarget([])).toBe(1);
    expect(orderUnitTarget(null)).toBe(1);
    expect(orderUnitTarget([{ kind: 'part', qty: 2, name: 'Lid' }])).toBe(1);
  });
});

describe('assignUnits', () => {
  it('reserves every picked machine', async () => {
    await assignUnits('q-1', THREE, 'o-1');

    expect(linkRows().map((r: any) => r.unit_serial)).toEqual(THREE);
    expect(unitPatches()).toHaveLength(3);
    for (const p of unitPatches()) {
      expect(p.patch).toMatchObject({
        status: 'reserved', customer_order_ref: 'M-0001', customer_name: 'James San Roman',
      });
    }
    // The shelf has to agree, or the board shows three machines free that are not.
    expect(slotPatches()).toHaveLength(3);
    expect(slotPatches().map(p => p.match.serial)).toEqual(THREE);
  });

  it('advances to step 2 with the first pick as assigned_serial', async () => {
    await assignUnits('q-1', THREE, 'o-1');
    // Not a replacement for the set — the single column keeps a true value for
    // the FK, the step-6 trigger and every older read.
    expect(queuePatch()).toEqual({ assigned_serial: 'LL01-0001', step: 2 });
  });

  it('does not re-point assigned_serial when a row is topped up', async () => {
    // Moving it would silently re-point the FK and the older reads at a
    // different machine than the one they have been naming all along.
    state.existingLinks = ['LL01-0001'];
    state.queueStep = 2;
    await assignUnits('q-1', ['LL01-0002'], 'o-1');
    expect(queuePatch()).toEqual({ assigned_serial: 'LL01-0001', step: 2 });
    // Past step 1 the existing pick is real, so nothing is released.
    expect(state.deletes).toHaveLength(0);
  });

  describe('a row still carrying links on step 1', () => {
    // Step 1 IS the assign step, so a link on a step-1 row is a leftover — the
    // QC flag used to rewind the row without releasing what it held. Order
    // #1286 piled up six of them over six flag-and-re-pick cycles, and the
    // board told the operator six machines were assigned to a customer she had
    // picked none for.
    beforeEach(() => {
      state.existingLinks = ['LL01-0001', 'LL01-0002'];
      state.unitStatuses['LL01-0001'] = 'reserved';
      state.unitStatuses['LL01-0002'] = 'rework';
      state.queueStep = 1;
    });

    it('releases the leftovers before reserving the new pick', async () => {
      await assignUnits('q-1', ['LL01-0003'], 'o-1');

      // The sibling that was still only reserved goes back into ready stock.
      const freed = unitPatches().find(p => p.match.serial === 'LL01-0001')!;
      expect(freed.patch).toEqual({ status: 'ready', customer_order_ref: null, customer_name: null });
      // The links go with it: the row owns exactly what was just picked.
      expect(state.deletes).toContainEqual({ table: 'fulfillment_queue_units', match: { queue_id: 'q-1' } });
      expect(linkRows().map((r: any) => r.unit_serial)).toEqual(['LL01-0003']);
    });

    it('leaves a flagged machine in rework rather than selling it again', async () => {
      await assignUnits('q-1', ['LL01-0003'], 'o-1');
      expect(unitPatches().find(p => p.match.serial === 'LL01-0002')).toBeUndefined();
    });

    it('points assigned_serial at the machine actually picked', async () => {
      // The leftover must not keep naming the row — the step-6 trigger ships
      // whatever assigned_serial and the links name.
      await assignUnits('q-1', ['LL01-0003'], 'o-1');
      expect(queuePatch()).toEqual({ assigned_serial: 'LL01-0003', step: 2 });
    });

    it('can re-pick a machine that was left reserved to this same order', async () => {
      // The leftover is released first for exactly this reason: otherwise the
      // pickable check sees 'reserved' and refuses the operator's own unit.
      await expect(assignUnits('q-1', ['LL01-0001'], 'o-1')).resolves.toBeUndefined();
      expect(queuePatch()).toEqual({ assigned_serial: 'LL01-0001', step: 2 });
    });
  });

  it('ignores a serial picked twice', async () => {
    await assignUnits('q-1', ['LL01-0001', 'LL01-0001'], 'o-1');
    expect(linkRows()).toHaveLength(1);
    expect(unitPatches()).toHaveLength(1);
  });

  it('pairs an already-shipped unit instead of reserving it', async () => {
    // Backlog #57's historical pairing, per unit so a mixed pick works.
    state.unitStatuses['LL01-0003'] = 'shipped';
    await assignUnits('q-1', THREE, 'o-1');

    const shipped = unitPatches().find(p => p.match.serial === 'LL01-0003')!;
    expect(shipped.patch).toMatchObject({ backfill_source: 'manual-backfill' });
    expect(shipped.patch.status).toBeUndefined();
    expect(shipped.patch.backfilled_at).toBeTruthy();
    expect(linkRows().find((r: any) => r.unit_serial === 'LL01-0003').is_backfill).toBe(true);
    expect(linkRows().find((r: any) => r.unit_serial === 'LL01-0001').is_backfill).toBe(false);
  });

  it('refuses the whole pick when one machine is not pickable', async () => {
    state.unitStatuses['LL01-0002'] = 'quarantine';
    await expect(assignUnits('q-1', THREE, 'o-1')).rejects.toThrow(/LL01-0002 is 'quarantine'/);
    // Nothing written: a partial reservation is worse than a refused one.
    expect(state.upserts).toHaveLength(0);
    expect(state.updates).toHaveLength(0);
  });

  it('rejects an empty pick', async () => {
    await expect(assignUnits('q-1', [], 'o-1')).rejects.toThrow(/at least one unit/i);
    expect(state.updates).toHaveLength(0);
  });

  it('logs every serial assigned', async () => {
    await assignUnits('q-1', THREE, 'o-1');
    expect(logAction).toHaveBeenCalledWith(
      'fq_assign', 'q-1', expect.stringContaining('LL01-0003'),
    );
  });

  describe('before the migration is applied', () => {
    // Migrations here are applied by hand, so a frontend deploy can land first.
    const missing = { code: '42P01', message: 'relation "fulfillment_queue_units" does not exist' };

    it('still assigns a single unit, exactly as it did before', async () => {
      state.linkError = missing;
      await assignUnits('q-1', ['LL01-0001'], 'o-1');

      expect(unitPatches()).toHaveLength(1);
      expect(queuePatch()).toEqual({ assigned_serial: 'LL01-0001', step: 2 });
    });

    it('refuses a multi-unit pick, and reserves nothing', async () => {
      state.linkError = missing;
      await expect(assignUnits('q-1', THREE, 'o-1')).rejects.toThrow(/migration that has not been applied/);
      // The ordering is the point: the fallible write goes first, so three
      // machines are not left stamped against a row with no record of them.
      expect(state.updates).toHaveLength(0);
    });

    it('names the migration and how to run it', async () => {
      state.linkError = missing;
      await expect(assignUnits('q-1', THREE, 'o-1')).rejects.toThrow(/20261001130000_fulfillment_queue_units/);
    });
  });

  it('surfaces a real failure on the link write rather than swallowing it', async () => {
    state.linkError = { code: '23503', message: 'insert or update violates foreign key constraint' };
    await expect(assignUnits('q-1', THREE, 'o-1')).rejects.toThrow(/Could not record the assigned units/);
    expect(state.updates).toHaveLength(0);
  });
});
