// Confirming pickup (step 5 → 6) also marks the Shopify order fulfilled, by
// calling push-shopify-fulfillments for that one queue row. The push is
// fire-and-forget: a Shopify failure must never block or undo the pickup.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { fromMock, state, logActionMock } = vi.hoisted(() => {
  const state: { queue: any; updates: Array<{ table: string; patch: any }> } = { queue: null, updates: [] };
  const terminal = (result: any): any => {
    const p: any = Promise.resolve(result);
    for (const m of ['eq', 'is', 'in', 'select', 'order'] as const) p[m] = () => terminal(result);
    p.single = () => Promise.resolve(result);
    p.maybeSingle = () => Promise.resolve(result);
    return p;
  };
  const fromMock = vi.fn((table: string) => ({
    select: () => terminal({ data: table === 'fulfillment_queue' ? state.queue : null, error: null }),
    update: (patch: any) => { state.updates.push({ table, patch }); return terminal({ data: null, error: null }); },
  }));
  const logActionMock = vi.fn((..._args: unknown[]) => Promise.resolve());
  return { fromMock, state, logActionMock };
});

vi.mock('./supabase', () => ({
  supabase: {
    from: fromMock,
    auth: {
      getUser: () => Promise.resolve({ data: { user: { id: 'user-1' } } }),
      getSession: () => Promise.resolve({ data: { session: { access_token: 'jwt-1' } } }),
    },
  },
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_ANON_KEY: 'anon',
}));
vi.mock('./activityLog', () => ({ logAction: logActionMock }));

import { confirmDock, pushShopifyFulfillment } from './fulfillment';

const fetchMock = vi.fn();
const respond = (status: number, body: unknown) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));
const flush = () => new Promise(r => setTimeout(r, 0));

beforeEach(() => {
  state.queue = { email_sent_at: '2026-11-17T10:00:00Z', assigned_serial: null };
  state.updates = [];
  fetchMock.mockReset();
  logActionMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('confirmDock → Shopify', () => {
  it('pushes this queue row to Shopify after marking it fulfilled', async () => {
    fetchMock.mockReturnValue(respond(200, { status: 'pushed', order_ref: '#1250' }));
    await confirmDock('q-1');
    await flush();

    expect(state.updates.find(u => u.table === 'fulfillment_queue')?.patch.step).toBe(6);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://example.supabase.co/functions/v1/push-shopify-fulfillments');
    expect(JSON.parse(init.body)).toEqual({ queue_id: 'q-1' });
    expect(init.headers.Authorization).toBe('Bearer jwt-1');
    expect(logActionMock).toHaveBeenCalledWith('fq_shopify_fulfilled', 'q-1', 'Marked #1250 fulfilled in Shopify');
  });

  it('still confirms the pickup when Shopify is down', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchMock.mockReturnValue(respond(500, { error: 'boom' }));
    await expect(confirmDock('q-1')).resolves.toBeUndefined();
    await flush();
    expect(logActionMock).toHaveBeenCalledWith('fq_dock_confirmed', 'q-1', 'Pickup confirmed — fulfilled');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('does not push when the pickup itself is refused', async () => {
    state.queue = { email_sent_at: null, assigned_serial: null };
    await expect(confirmDock('q-1')).rejects.toThrow(/shipping email/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('pushShopifyFulfillment', () => {
  it('logs a Shopify-side failure to the activity log', async () => {
    fetchMock.mockReturnValue(respond(200, { status: 'failed', error: 'Shopify fulfillment POST 403', order_ref: '#1250' }));
    const r = await pushShopifyFulfillment('q-1');
    expect(r.status).toBe('failed');
    expect(logActionMock).toHaveBeenCalledWith('fq_shopify_sync_failed', 'q-1', 'Shopify sync failed for #1250: Shopify fulfillment POST 403');
  });

  it('stays quiet about replacements, which have no Shopify order', async () => {
    fetchMock.mockReturnValue(respond(200, { status: 'skipped', reason: 'replacement — not a Shopify order', order_ref: 'R-0090' }));
    await pushShopifyFulfillment('q-1');
    expect(logActionMock).not.toHaveBeenCalled();
  });

  it('surfaces the function error body on non-2xx', async () => {
    fetchMock.mockReturnValue(respond(409, { error: 'This order is not fulfilled in makeLILA yet.' }));
    await expect(pushShopifyFulfillment('q-1')).rejects.toThrow('Shopify sync failed (409): This order is not fulfilled in makeLILA yet.');
  });
});
