// Mock fixtures pass `as any` to satisfy the polymorphic supabase client
// surface — this is the right escape valve for test mocks.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { invokeMock, logActionMock } = vi.hoisted(() => ({
  invokeMock: vi.fn<(...args: any[]) => Promise<any>>(),
  logActionMock: vi.fn(() => Promise.resolve()),
}));

vi.mock('./supabase', () => ({
  supabase: {
    functions: { invoke: invokeMock },
    from: vi.fn(),
    auth: { getSession: vi.fn(() => Promise.resolve({ data: { session: null } })) },
    channel: vi.fn(() => ({
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn().mockReturnThis(),
      unsubscribe: vi.fn(),
    })),
  },
  SUPABASE_URL: 'https://test.supabase.co',
  SUPABASE_ANON_KEY: 'anon-key',
}));

vi.mock('./activityLog', () => ({ logAction: logActionMock }));

import { syncShopifyOrders, SHOPIFY_SKIP_LABEL } from './orders';

const fullBody = {
  mode: 'full',
  fetched: 252,
  imported: 0,
  refreshed: 221,
  skipped: 31,
  skippedBreakdown: { no_shipping_address: 31 },
  journeyBatchesFailed: 0,
  skippedDetails: [
    {
      order_ref: '#1249',
      reason: 'no_shipping_address',
      detail: '',
      placed_at: '2026-09-05T14:44:02Z',
      total: '1.05',
      currency: 'CAD',
      customer: 'Natalie Lanctot',
      items: ['LILA Mini Reservation'],
    },
  ],
};

beforeEach(() => {
  invokeMock.mockReset();
  logActionMock.mockClear();
});

describe('syncShopifyOrders', () => {
  it('passes the whole result through, skip detail included', async () => {
    invokeMock.mockResolvedValue({ data: fullBody, error: null });

    const r = await syncShopifyOrders();

    expect(r.fetched).toBe(252);
    expect(r.imported).toBe(0);
    expect(r.refreshed).toBe(221);
    expect(r.skipped).toBe(31);
    expect(r.skippedDetails).toHaveLength(1);
    expect(r.skippedDetails[0].order_ref).toBe('#1249');
    expect(r.skippedDetails[0].reason).toBe('no_shipping_address');
  });

  it('aborts rather than leaving the caller waiting forever', async () => {
    invokeMock.mockImplementation((_fn: string, opts: any) => {
      expect(opts.signal).toBeInstanceOf(AbortSignal);
      return Promise.resolve({ data: fullBody, error: null });
    });

    await syncShopifyOrders();

    expect(invokeMock).toHaveBeenCalledOnce();
  });

  it('turns a timeout into an instruction, not a dead end', async () => {
    const timeout = new Error('The signal has been aborted');
    timeout.name = 'TimeoutError';
    invokeMock.mockRejectedValue(timeout);

    await expect(syncShopifyOrders()).rejects.toThrow(/Timed out after 180s/);
    await expect(syncShopifyOrders()).rejects.toThrow(/may still be finishing/);
  });

  it('surfaces the function’s own error text, not the generic non-2xx', async () => {
    // supabase-js reports every non-2xx as "non-2xx status code" and hides the
    // real cause on error.context. A dead Shopify token has to read as one.
    const err: any = new Error('Edge Function returned a non-2xx status code');
    err.context = new Response(
      JSON.stringify({ error: 'Shopify 401: [API] Invalid API key or access token' }),
      { status: 502, headers: { 'content-type': 'application/json' } },
    );
    invokeMock.mockResolvedValue({ data: null, error: err });

    await expect(syncShopifyOrders()).rejects.toThrow(/Invalid API key or access token/);
  });

  it('defaults the new fields so a stale edge function cannot crash Sales', async () => {
    // The deploy is two pieces: Pages and the edge function. Between them the
    // frontend can be new while the function still returns the old shape.
    invokeMock.mockResolvedValue({
      data: { fetched: 10, imported: 2, skipped: 1 },
      error: null,
    });

    const r = await syncShopifyOrders();

    expect(r.refreshed).toBe(0);
    expect(r.skippedDetails).toEqual([]);
    expect(r.skippedBreakdown).toEqual({});
    expect(r.journeyBatchesFailed).toBe(0);
  });

  it('writes the run to the activity log', async () => {
    invokeMock.mockResolvedValue({ data: fullBody, error: null });

    await syncShopifyOrders();

    expect(logActionMock).toHaveBeenCalledWith(
      'shopify_sync',
      'orders',
      '0 new, 221 refreshed, 31 not imported (of 252 fetched)',
    );
  });

  it('names every skip reason the edge function can return', () => {
    expect(Object.keys(SHOPIFY_SKIP_LABEL).sort()).toEqual([
      'db_error', 'international', 'missing_city', 'no_shipping_address',
    ]);
  });
});
