// Claiming a serial range under a batch + PO (Build › "+ Claim serials").
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Op = { op: string; args: unknown[] };

const { fromMock, calls, results, logActionMock } = vi.hoisted(() => {
  const calls: { op: string; args: unknown[] }[][] = [];
  const results: { data?: unknown; error: unknown }[] = [];
  const logActionMock = vi.fn((..._args: unknown[]) => Promise.resolve());
  // Each supabase.from() call takes the next queued result and records every
  // chained method, so a test can assert the exact filters a write used.
  const fromMock = vi.fn((table: string) => {
    const rec: { op: string; args: unknown[] }[] = [{ op: 'from', args: [table] }];
    calls.push(rec);
    const result = results.shift() ?? { data: [], error: null };
    const chain: object = new Proxy({}, {
      get(_t, prop) {
        if (typeof prop === 'symbol') return undefined;
        if (prop === 'then') {
          return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
            Promise.resolve(result).then(res, rej);
        }
        return (...args: unknown[]) => { rec.push({ op: prop, args }); return chain; };
      },
    });
    return chain;
  });
  return { fromMock, calls, results, logActionMock };
});

vi.mock('./supabase', () => ({ supabase: { from: fromMock } }));
vi.mock('./activityLog', () => ({ logAction: logActionMock }));

import {
  formatSerial, parseSerialInput, planSerialRange, unitsMadeForPO, MAX_CLAIM_RANGE,
  claimSerialRange, assignSerial,
} from './build';

const S = (n: number) => `LL01-${String(n).padStart(11, '0')}`;
const args = (call: Op[], op: string) => call.find(c => c.op === op)?.args;

beforeEach(() => {
  calls.length = 0;
  results.length = 0;
  fromMock.mockClear();
  logActionMock.mockClear();
});

describe('formatSerial / parseSerialInput', () => {
  it('formats a number as a full serial', () => {
    expect(formatSerial(691)).toBe('LL01-00000000691');
  });

  it('accepts a bare number, a padded number, or a full serial in any case', () => {
    for (const raw of ['691', '00000000691', 'LL01-00000000691', 'll01-00000000691', '  691  ']) {
      expect(parseSerialInput(raw)).toBe(691);
    }
  });

  it('rejects anything that is not a serial', () => {
    for (const raw of ['', '   ', 'abc', 'LL02-00000000691', '123456789012', '0', '69 1', '-5']) {
      expect(parseSerialInput(raw)).toBeNull();
    }
  });
});

describe('planSerialRange', () => {
  const existing = [
    { serial: S(691), batch: 'P300', po_id: null },
    { serial: S(692), batch: 'P100', po_id: null },
    { serial: S(693), batch: 'P300', po_id: 'po1' },
    { serial: S(694), batch: 'P300', po_id: 'po2' },
  ];

  it('sorts every serial into create, link or skip', () => {
    const p = planSerialRange({ from: 691, to: 696, batch: 'P300', poId: 'po1', existing });
    expect(p.serials).toEqual([S(691), S(692), S(693), S(694), S(695), S(696)]);
    expect(p.create).toEqual([S(695), S(696)]);
    expect(p.linkPo).toEqual([S(691)]);
    expect(p.skipped).toEqual([
      { serial: S(692), reason: 'other_batch', detail: 'P100' },
      { serial: S(693), reason: 'same_po' },
      { serial: S(694), reason: 'other_po' },
    ]);
  });

  it('skips a same-batch unit with no PO when no PO was chosen', () => {
    const p = planSerialRange({ from: 691, to: 691, batch: 'P300', poId: null, existing });
    expect(p.linkPo).toEqual([]);
    expect(p.skipped).toEqual([{ serial: S(691), reason: 'exists' }]);
  });

  it('rejects a reversed range', () => {
    expect(() => planSerialRange({ from: 780, to: 691, batch: 'P300', poId: null, existing: [] }))
      .toThrow('The first serial must not come after the last');
  });

  it(`allows ${MAX_CLAIM_RANGE} serials and rejects one more`, () => {
    expect(planSerialRange({ from: 1, to: MAX_CLAIM_RANGE, batch: 'P300', poId: null, existing: [] }).create)
      .toHaveLength(MAX_CLAIM_RANGE);
    expect(() => planSerialRange({ from: 1, to: MAX_CLAIM_RANGE + 1, batch: 'P300', poId: null, existing: [] }))
      .toThrow(`A range can hold at most ${MAX_CLAIM_RANGE} serials`);
  });
});

describe('unitsMadeForPO', () => {
  it('counts units on this PO plus unlinked units in its batch', () => {
    const units = [
      { batch: 'P300', po_id: 'po1' },
      { batch: 'P300', po_id: null },
      { batch: 'P300', po_id: 'po2' },
      { batch: 'P100', po_id: null },
      { batch: 'P100', po_id: 'po1' },
    ];
    expect(unitsMadeForPO({ id: 'po1', batch: 'P300' }, units)).toBe(3);
  });

  it('matches the old batch count while nothing is linked', () => {
    const units = [{ batch: 'P300', po_id: null }, { batch: 'P300', po_id: null }, { batch: 'P100', po_id: null }];
    expect(unitsMadeForPO({ id: 'po1', batch: 'P300' }, units)).toBe(2);
  });
});

describe('claimSerialRange', () => {
  const PO = { id: 'po1', po_number: 'PO-1012' };
  const happyPath = () => results.push(
    { data: [{ serial: S(691), batch: 'P300', po_id: null }], error: null },        // read
    { data: [692, 693, 694, 695].map(n => ({ serial: S(n) })), error: null },      // insert
    { data: [{ serial: S(691) }], error: null },                                   // link
  );

  it('reads the range, inserts new units once, and fills the PO on unlinked same-batch units', async () => {
    happyPath();
    const r = await claimSerialRange({ from: 691, to: 695, batch: 'P300', po: PO });

    expect(calls).toHaveLength(3);
    expect(args(calls[0], 'select')).toEqual(['serial, batch, po_id']);
    expect(args(calls[0], 'gte')).toEqual(['serial', S(691)]);
    expect(args(calls[0], 'lte')).toEqual(['serial', S(695)]);

    const [rows, opts] = args(calls[1], 'upsert')!;
    expect(rows).toEqual([692, 693, 694, 695].map(n => ({ serial: S(n), batch: 'P300', status: 'ca-test', po_id: 'po1' })));
    expect(opts).toEqual({ onConflict: 'serial', ignoreDuplicates: true });

    expect(args(calls[2], 'update')).toEqual([{ po_id: 'po1' }]);
    expect(args(calls[2], 'gte')).toEqual(['serial', S(691)]);
    expect(args(calls[2], 'lte')).toEqual(['serial', S(695)]);
    expect(args(calls[2], 'eq')).toEqual(['batch', 'P300']);
    expect(args(calls[2], 'is')).toEqual(['po_id', null]);

    expect(r).toEqual({ created: [S(692), S(693), S(694), S(695)], linked: [S(691)], skipped: [] });
  });

  it('logs every created and linked unit, plus one summary', async () => {
    happyPath();
    await claimSerialRange({ from: 691, to: 695, batch: 'P300', po: PO });
    expect(logActionMock.mock.calls.filter(c => c[0] === 'serial_assigned')).toHaveLength(4);
    expect(logActionMock).toHaveBeenCalledWith('serial_assigned', S(692), 'P300', { entityType: 'unit', unitSerial: S(692) });
    expect(logActionMock).toHaveBeenCalledWith('unit_po_linked', S(691), 'PO-1012', { entityType: 'unit', unitSerial: S(691) });
    expect(logActionMock).toHaveBeenCalledWith('serials_claimed_range', 'PO-1012', `${S(691)}–${S(695)}: 4 created, 1 linked, 0 skipped`);
  });

  it('treats a serial the insert did not return as already existing', async () => {
    results.push({ data: [], error: null }, { data: [{ serial: S(691) }], error: null });
    const r = await claimSerialRange({ from: 691, to: 692, batch: 'P300', po: null });
    expect(r.created).toEqual([S(691)]);
    expect(r.skipped).toEqual([{ serial: S(692), reason: 'exists' }]);
  });

  it('without a PO: rows carry no po_id, nothing is linked, same-batch units are skipped', async () => {
    results.push(
      { data: [{ serial: S(691), batch: 'P300', po_id: null }], error: null },
      { data: [{ serial: S(692) }], error: null },
    );
    const r = await claimSerialRange({ from: 691, to: 692, batch: 'P300', po: null });
    expect(calls).toHaveLength(2);
    expect(args(calls[1], 'upsert')![0]).toEqual([{ serial: S(692), batch: 'P300', status: 'ca-test' }]);
    expect(r).toEqual({ created: [S(692)], linked: [], skipped: [{ serial: S(691), reason: 'exists' }] });
    expect(logActionMock).toHaveBeenCalledWith('serials_claimed_range', 'P300', `${S(691)}–${S(692)}: 1 created, 0 linked, 1 skipped`);
  });

  it('marks a planned link that was taken in the meantime as on another PO', async () => {
    results.push(
      { data: [{ serial: S(691), batch: 'P300', po_id: null }, { serial: S(692), batch: 'P300', po_id: null }], error: null },
      { data: [{ serial: S(691) }], error: null },
    );
    const r = await claimSerialRange({ from: 691, to: 692, batch: 'P300', po: PO });
    expect(calls).toHaveLength(2);
    expect(r.linked).toEqual([S(691)]);
    expect(r.skipped).toEqual([{ serial: S(692), reason: 'other_po' }]);
  });

  it('writes and logs nothing when every serial is already taken', async () => {
    results.push({ data: [{ serial: S(691), batch: 'P100', po_id: null }], error: null });
    const r = await claimSerialRange({ from: 691, to: 691, batch: 'P300', po: PO });
    expect(calls).toHaveLength(1);
    expect(r).toEqual({ created: [], linked: [], skipped: [{ serial: S(691), reason: 'other_batch', detail: 'P100' }] });
    expect(logActionMock).not.toHaveBeenCalled();
  });

  it('rejects a reversed range before touching the database', async () => {
    await expect(claimSerialRange({ from: 700, to: 691, batch: 'P300', po: null }))
      .rejects.toThrow('The first serial must not come after the last');
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('throws when the insert fails, and logs nothing', async () => {
    results.push({ data: [], error: null }, { data: null, error: { message: 'insert blew up' } });
    await expect(claimSerialRange({ from: 691, to: 691, batch: 'P300', po: null }))
      .rejects.toMatchObject({ message: 'insert blew up' });
    expect(logActionMock).not.toHaveBeenCalled();
  });
});

describe('assignSerial', () => {
  it('writes the PO when one is given', async () => {
    results.push({ error: null });
    await assignSerial({ serial: S(701), batch: 'P300', po_id: 'po1' });
    expect(args(calls[0], 'insert')).toEqual([{ serial: S(701), batch: 'P300', status: 'ca-test', po_id: 'po1' }]);
  });

  it('leaves po_id off the row without a PO', async () => {
    results.push({ error: null });
    await assignSerial({ serial: S(701), batch: 'P300' });
    expect(args(calls[0], 'insert')).toEqual([{ serial: S(701), batch: 'P300', status: 'ca-test' }]);
  });
});
