import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import {
  toIssue, groupByProduct, computeFleetStats, useProductIssues, sendIssueChatMessage,
  type DbProductIssue,
} from './products';

const { mockResolve, mockOn, mockSubscribe, mockChannel, mockInvoke } = vi.hoisted(() => {
  const mockResolve = vi.fn();
  const mockUnsubscribe = vi.fn();
  const mockOn = vi.fn().mockReturnThis();
  const mockSubscribe = vi.fn().mockReturnThis();
  const mockChannel = vi.fn(() => ({ on: mockOn, subscribe: mockSubscribe, unsubscribe: mockUnsubscribe }));
  const mockInvoke = vi.fn();
  return { mockResolve, mockOn, mockSubscribe, mockUnsubscribe, mockChannel, mockInvoke };
});

vi.mock('./supabase', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const builder: any = {};
  builder.select = () => builder;
  builder.then = (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
    mockResolve().then(onFulfilled, onRejected);
  return {
    supabase: {
      from: () => builder,
      channel: mockChannel,
      functions: { invoke: mockInvoke },
    },
  };
});

const ROW_PRO: DbProductIssue = {
  id: 'row-1', product_id: 'pro', title: 'Latch snaps off', severity: 'high',
  tag: 'Hardware · Latch', team: 'Ben Liang', meta: 'Breaks under normal use.',
  link: null, mp_blocker: true, source: 'seed', created_by: null, created_by_name: null,
  created_at: '2026-07-01T00:00:00.000Z',
};
const ROW_SHOP: DbProductIssue = {
  id: 'row-2', product_id: 'shop', title: 'CAC too high', severity: 'critical',
  tag: 'Marketing', team: 'Pedrum', meta: 'CAC is $400+.',
  link: null, mp_blocker: false, source: 'seed', created_by: null, created_by_name: null,
  created_at: '2026-07-01T00:00:00.000Z',
};

describe('toIssue', () => {
  it('maps a DB row to the Issue shape', () => {
    expect(toIssue(ROW_PRO)).toEqual({
      title: 'Latch snaps off', sev: 'high', tag: 'Hardware · Latch',
      team: 'Ben Liang', meta: 'Breaks under normal use.', mpBlocker: true,
    });
  });

  it('defaults a null team to an empty string', () => {
    expect(toIssue({ ...ROW_PRO, team: null }).team).toBe('');
  });
});

describe('groupByProduct', () => {
  it('groups rows by product_id', () => {
    const result = groupByProduct([ROW_PRO, ROW_SHOP, { ...ROW_PRO, id: 'row-3' }]);
    expect(result.pro).toHaveLength(2);
    expect(result.shop).toHaveLength(1);
  });

  it('returns an empty object for no rows', () => {
    expect(groupByProduct([])).toEqual({});
  });
});

describe('computeFleetStats', () => {
  const issuesByProduct = groupByProduct([ROW_PRO, ROW_SHOP]);
  const products = [
    { id: 'pro', stage: 'PP' },
    { id: 'shop', stage: 'GROW' },
    { id: 'mega', stage: 'EP' },
  ];

  it('totals open, critical, and MP-blocker issues across all lines', () => {
    const stats = computeFleetStats(issuesByProduct, products);
    expect(stats.totalOpen).toBe(2);
    expect(stats.totalCritical).toBe(1);
    expect(stats.totalMpBlockers).toBe(1);
    expect(stats.lineCount).toBe(3);
  });

  it('gives each product line its own open/critical count, zero for lines with no issues', () => {
    const stats = computeFleetStats(issuesByProduct, products);
    expect(stats.perLine).toEqual([
      { productId: 'pro', stage: 'PP', openCount: 1, criticalCount: 0 },
      { productId: 'shop', stage: 'GROW', openCount: 1, criticalCount: 1 },
      { productId: 'mega', stage: 'EP', openCount: 0, criticalCount: 0 },
    ]);
  });
});

describe('useProductIssues', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOn.mockReturnThis();
    mockSubscribe.mockReturnThis();
  });

  it('loads rows and groups them by product', async () => {
    mockResolve.mockResolvedValueOnce({ data: [ROW_PRO, ROW_SHOP], error: null });
    const { result } = renderHook(() => useProductIssues());
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.issuesByProduct.pro).toHaveLength(1);
    expect(result.current.issuesByProduct.shop).toHaveLength(1);
  });

  it('subscribes to realtime INSERTs on product_issues', async () => {
    mockResolve.mockResolvedValueOnce({ data: [], error: null });
    renderHook(() => useProductIssues());
    await waitFor(() => expect(mockChannel).toHaveBeenCalledWith('product_issues:realtime'));
    expect(mockOn).toHaveBeenCalledWith(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'product_issues' },
      expect.any(Function),
    );
  });

  it('appends a realtime INSERT payload into the right product group', async () => {
    mockResolve.mockResolvedValueOnce({ data: [], error: null });
    const { result } = renderHook(() => useProductIssues());
    await waitFor(() => expect(result.current.loading).toBe(false));

    const insertHandler = mockOn.mock.calls[0][2] as (payload: { new: DbProductIssue }) => void;
    act(() => { insertHandler({ new: ROW_PRO }); });

    expect(result.current.issuesByProduct.pro).toHaveLength(1);
  });
});

describe('sendIssueChatMessage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('invokes the product-issue-chat function and returns its data', async () => {
    mockInvoke.mockResolvedValueOnce({ data: { reply: 'Got it.', filed: false }, error: null });
    const result = await sendIssueChatMessage({
      messages: [{ role: 'user', content: 'latches keep breaking' }],
      product_id: 'pro',
      products: [{ id: 'pro', label: 'LILA Pro' }],
      knownTeam: ['Ben Liang'],
    });
    expect(mockInvoke).toHaveBeenCalledWith('product-issue-chat', {
      body: {
        messages: [{ role: 'user', content: 'latches keep breaking' }],
        product_id: 'pro',
        products: [{ id: 'pro', label: 'LILA Pro' }],
        knownTeam: ['Ben Liang'],
      },
    });
    expect(result).toEqual({ reply: 'Got it.', filed: false });
  });

  it('throws when the function call errors', async () => {
    mockInvoke.mockResolvedValueOnce({ data: null, error: new Error('network down') });
    await expect(sendIssueChatMessage({
      messages: [], product_id: null, products: [], knownTeam: [],
    })).rejects.toThrow('network down');
  });
});
