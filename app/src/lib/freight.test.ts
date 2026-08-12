/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Supabase mock ────────────────────────────────────────────────────────────
// A recording query builder: every call to supabase.from(t) starts a fresh
// chain, the terminal await resolves whatever was queued for `${table}.${op}`,
// and each chain is pushed to `calls` so a test can assert what was written and
// with which filters. Queue values may be a single result (reused) or an array
// (consumed in order) when one table takes several writes in a single flow.
const { fromMock, calls, queue, invokeMock } = vi.hoisted(() => {
  type Call = { table: string; op: string; payload?: unknown; filters: Array<[string, unknown]> };
  const calls: Call[] = [];
  const queue: Record<string, any> = {};

  const fromMock = vi.fn((table: string) => {
    const api: any = {};
    let current: Call | null = null;

    const start = (op: string, payload?: unknown) => {
      current = { table, op, payload, filters: [] };
      calls.push(current);
      return api;
    };

    api.select = (cols?: unknown) => (current ? api : start('select', cols));
    api.insert = (row: unknown) => start('insert', row);
    api.update = (row: unknown) => start('update', row);
    api.delete = () => start('delete');
    api.eq = (col: string, val: unknown) => { current?.filters.push([col, val]); return api; };
    api.order = () => api;
    api.single = () => api;
    api.maybeSingle = () => api;

    api.then = (resolve: any, reject: any) => {
      const key = `${table}.${current?.op}`;
      const queued = queue[key];
      const result = Array.isArray(queued) ? (queued.shift() ?? { data: null, error: null })
                   : queued ?? { data: null, error: null };
      return Promise.resolve(result).then(resolve, reject);
    };
    api.catch = (reject: any) => api.then(undefined, reject);

    return api;
  });

  const invokeMock = vi.fn();
  return { fromMock, calls, queue, invokeMock };
});

vi.mock('./supabase', () => ({
  supabase: {
    from: fromMock,
    functions: { invoke: invokeMock },
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } } }) },
  },
}));
vi.mock('./activityLog', () => ({ logAction: vi.fn().mockResolvedValue(undefined) }));

import { selectQuote, fetchFreightcomQuotes, cheapestCadQuote, type FreightQuote } from './freight';

function reset() {
  fromMock.mockClear();
  invokeMock.mockReset();
  calls.length = 0;
  for (const k of Object.keys(queue)) delete queue[k];
}

function quoteRow(over: Record<string, unknown> = {}) {
  return {
    data: {
      id: 'q-target', order_id: 'ord-1', provider: 'freightcom',
      service_level: 'Purolator — Ground', rate_cad: 143.75, rate_usd: null, ...over,
    },
    error: null,
  };
}

const writes = (table: string, op: string) => calls.filter(c => c.table === table && c.op === op);

describe('selectQuote', () => {
  beforeEach(reset);

  it('sets selected=false on all sibling rows then selected=true on the target', async () => {
    queue['freight_quotes.select'] = quoteRow();

    await selectQuote('ord-1', 'q-target');

    expect(fromMock).toHaveBeenCalledWith('freight_quotes');
    const updates = writes('freight_quotes', 'update');
    expect(updates[0].payload).toEqual({ selected: false });
    expect(updates[1].payload).toEqual({ selected: true });
  });

  // The bug this covers: quoting wrote rows to freight_quotes but never touched
  // the order, so Sales → Freight Estimate stayed at "$0.00 · operator edit"
  // however many carrier quotes had been pulled.
  it('copies the chosen rate onto the order as the freight estimate', async () => {
    queue['freight_quotes.select'] = quoteRow({ rate_cad: 143.75, provider: 'freightcom' });

    await selectQuote('ord-1', 'q-target');

    const [orderUpdate] = writes('orders', 'update');
    expect(orderUpdate.payload).toEqual({
      freight_estimate_usd: 143.75,
      freight_estimate_source: 'freightcom',
    });
    expect(orderUpdate.filters).toContainEqual(['id', 'ord-1']);
  });

  // freight_estimate_usd is rendered as CAD by FreightCard, so a USD-only quote
  // must not be written into it — that would silently misprice the order.
  it('leaves the estimate alone when the quote carries no CAD rate', async () => {
    queue['freight_quotes.select'] = quoteRow({ rate_cad: null, rate_usd: 99 });

    await selectQuote('ord-1', 'q-target');

    expect(writes('orders', 'update')).toHaveLength(0);
    expect(writes('freight_quotes', 'update')).toHaveLength(2);
  });

  it('throws when Supabase returns an error', async () => {
    queue['freight_quotes.select'] = quoteRow();
    queue['freight_quotes.update'] = [{ error: { message: 'DB error' } }];
    await expect(selectQuote('ord-1', 'q-target')).rejects.toThrow('DB error');
  });
});

describe('cheapestCadQuote', () => {
  const q = (over: Partial<FreightQuote>): FreightQuote => ({
    id: 'q', order_id: 'ord-1', provider: 'freightcom', service_level: 'svc',
    rate_cad: null, rate_usd: null, transit_days: null,
    quoted_at: '2026-08-12T00:00:00Z', selected: false, raw: {}, ...over,
  });

  it('picks the lowest CAD rate', () => {
    const cheapest = cheapestCadQuote([
      q({ id: 'a', rate_cad: 210.4 }), q({ id: 'b', rate_cad: 143.75 }), q({ id: 'c', rate_cad: 188 }),
    ]);
    expect(cheapest?.id).toBe('b');
  });

  it('ignores quotes priced only in USD', () => {
    const cheapest = cheapestCadQuote([q({ id: 'usd', rate_usd: 20 }), q({ id: 'cad', rate_cad: 143.75 })]);
    expect(cheapest?.id).toBe('cad');
  });

  it('returns null when nothing is priced in CAD', () => {
    expect(cheapestCadQuote([q({ id: 'usd', rate_usd: 20 })])).toBeNull();
    expect(cheapestCadQuote([])).toBeNull();
  });
});

describe('fetchFreightcomQuotes', () => {
  beforeEach(reset);

  // supabase-js collapses every non-2xx edge-function reply into "Edge Function
  // returned a non-2xx status code". That opaque string is why a hard 404 from
  // freightcom-quote read as a flaky network call for months.
  it('surfaces the edge function\'s own error message', async () => {
    invokeMock.mockResolvedValue({
      data: null,
      error: Object.assign(new Error('Edge Function returned a non-2xx status code'), {
        context: new Response(JSON.stringify({ error: 'Order has no destination postal code' }), { status: 400 }),
      }),
    });

    await expect(fetchFreightcomQuotes('ord-1')).rejects.toThrow('Order has no destination postal code');
  });

  it('returns the quotes the function inserted', async () => {
    invokeMock.mockResolvedValue({ data: { quotes: [{ id: 'q-1' }], count: 1 }, error: null });
    await expect(fetchFreightcomQuotes('ord-1')).resolves.toEqual([{ id: 'q-1' }]);
  });
});
