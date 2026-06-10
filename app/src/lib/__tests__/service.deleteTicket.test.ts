/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Per-test config: what each (table:operation) query resolves to.
let results: Record<string, any>;
// Flat log of every builder method call so we can assert on the chain.
let calls: { table: string; method: string; args: any[] }[];

const { fromMock, logActionMock } = vi.hoisted(() => ({
  fromMock: vi.fn(),
  logActionMock: vi.fn(() => Promise.resolve()),
}));

vi.mock('../supabase', () => ({ supabase: { from: fromMock } }));
vi.mock('../activityLog', () => ({ logAction: logActionMock }));

import { deleteTicket } from '../service';

function builder(table: string) {
  let op = '';
  const b: any = {};
  for (const m of ['select', 'eq', 'is', 'update', 'delete', 'order', 'limit', 'single', 'maybeSingle']) {
    b[m] = (...args: any[]) => {
      calls.push({ table, method: m, args });
      if ((m === 'select' || m === 'update' || m === 'delete') && !op) op = m;
      return b;
    };
  }
  b.then = (resolve: any, reject: any) =>
    Promise.resolve(results[`${table}:${op}`] ?? { data: null, error: null }).then(resolve, reject);
  return b;
}

beforeEach(() => {
  calls = [];
  logActionMock.mockClear();
  fromMock.mockImplementation((table: string) => builder(table));
});

describe('deleteTicket — replacement cascade', () => {
  it('deletes a linked queued replacement, frees its reserved units, then deletes the ticket', async () => {
    results = {
      'orders:select': { data: [{ id: 'o1', order_ref: 'R-0001' }], error: null },
      'units:update': { error: null },
      'orders:delete': { error: null },
      'service_tickets:delete': { data: [{ id: 't1' }], error: null },
    };

    await deleteTicket('t1');

    // Looked up un-shipped replacements linked to the ticket.
    expect(calls).toContainEqual(expect.objectContaining({ table: 'orders', method: 'select' }));
    // Freed reserved units for that replacement.
    const unitUpdate = calls.find(c => c.table === 'units' && c.method === 'update');
    expect(unitUpdate?.args[0]).toEqual({ status: 'ready', customer_order_ref: null });
    expect(calls).toContainEqual(expect.objectContaining({ table: 'units', method: 'eq', args: ['customer_order_ref', 'R-0001'] }));
    // Deleted the replacement order + logged it.
    expect(calls).toContainEqual(expect.objectContaining({ table: 'orders', method: 'delete' }));
    expect(logActionMock).toHaveBeenCalledWith('replacement_deleted', 'R-0001', expect.stringContaining('t1'));
    // Finally deleted the ticket.
    expect(calls).toContainEqual(expect.objectContaining({ table: 'service_tickets', method: 'delete' }));
    expect(logActionMock).toHaveBeenCalledWith('ticket_deleted', 't1', 'Ticket deleted', expect.anything());
  });

  it('deletes the ticket normally when no replacement is linked', async () => {
    results = {
      'orders:select': { data: [], error: null },
      'service_tickets:delete': { data: [{ id: 't2' }], error: null },
    };

    await deleteTicket('t2');

    expect(calls.some(c => c.table === 'orders' && c.method === 'delete')).toBe(false);
    expect(calls).toContainEqual(expect.objectContaining({ table: 'service_tickets', method: 'delete' }));
  });
});
