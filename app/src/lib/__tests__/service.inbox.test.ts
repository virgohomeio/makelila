import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { promoteToTicket, setInboxDisposition, useInbox } from '../service';
import { logAction } from '../activityLog';

// ---------- Update chain (used by mutators) ----------
// eqMock is thenable so `await supabase.from(...).update({...}).eq('id', id)` resolves.
// Return type is intentionally `unknown` so tests can override with error shapes.
const eqMock = vi.fn<(...args: unknown[]) => unknown>(() => ({
  then: (cb: (r: { data: unknown; error: unknown }) => unknown) =>
    cb({ data: null, error: null }),
}));
const updateChainMock = vi.fn(() => ({ eq: eqMock }));

// ---------- Select chain (used by useInbox) ----------
// Captures every call so query-shape tests can assert against it. Each chain
// method returns the same chain object (so any order is valid) and the chain
// itself is thenable (so `await q` resolves with an empty dataset).
const selectChainCalls: Array<{ method: string; args: unknown[] }> = [];

function makeSelectChain() {
  const record = (method: string) => (...args: unknown[]) => {
    selectChainCalls.push({ method, args });
    return chain;
  };
  const chain: Record<string, unknown> = {};
  chain.select = record('select');
  chain.eq = record('eq');
  chain.is = record('is');
  chain.order = record('order');
  chain.then = (cb: (r: { data: never[]; error: null }) => unknown) =>
    cb({ data: [], error: null });
  return chain;
}

vi.mock('../supabase', () => ({
  supabase: {
    from: vi.fn(() => ({
      update: updateChainMock,
      select: (...args: unknown[]) => {
        selectChainCalls.push({ method: 'select', args });
        return makeSelectChain();
      },
    })),
    channel: vi.fn(() => {
      const ch: Record<string, unknown> = {};
      ch.on = vi.fn(() => ch);
      ch.subscribe = vi.fn(() => ch);
      ch.unsubscribe = vi.fn();
      return ch;
    }),
  },
  SUPABASE_URL: '',
  SUPABASE_ANON_KEY: '',
}));

vi.mock('../activityLog', () => ({ logAction: vi.fn().mockResolvedValue(undefined) }));

beforeEach(() => {
  eqMock.mockClear();
  updateChainMock.mockClear();
  selectChainCalls.length = 0;
  (logAction as unknown as { mockClear: () => void }).mockClear();
  // Reset eqMock to its default success behavior in case a prior test queued an error.
  eqMock.mockImplementation(() => ({
    then: (cb: (r: { data: unknown; error: unknown }) => unknown) =>
      cb({ data: null, error: null }),
  }));
});

describe('promoteToTicket', () => {
  it('flips kind to ticket, sets promoted disposition + category + owner', async () => {
    await promoteToTicket('row-1', {
      category: 'support',
      owner_email: 'reina@virgohome.io',
    });
    expect(updateChainMock).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'ticket',
      inbox_disposition: 'promoted',
      category: 'support',
      owner_email: 'reina@virgohome.io',
      status: 'triaging',
    }));
    expect(eqMock).toHaveBeenCalledWith('id', 'row-1');
  });
});

describe('setInboxDisposition', () => {
  it('updates disposition without flipping kind for sales/follow_up/dismissed', async () => {
    await setInboxDisposition('row-2', 'sales');
    expect(updateChainMock).toHaveBeenCalledWith({ inbox_disposition: 'sales' });
    expect(eqMock).toHaveBeenCalledWith('id', 'row-2');
  });

  it('clears disposition when passed null', async () => {
    await setInboxDisposition('row-3', null);
    expect(updateChainMock).toHaveBeenCalledWith({ inbox_disposition: null });
  });
});

describe('promoteToTicket error path', () => {
  it('throws the Supabase error when update fails', async () => {
    eqMock.mockReturnValueOnce({
      then: (cb: (r: { data: null; error: { message: string } }) => unknown) =>
        cb({ data: null, error: { message: 'permission denied' } }),
    });
    await expect(
      promoteToTicket('row-err', { category: 'support', owner_email: 'a@b.io' }),
    ).rejects.toMatchObject({ message: 'permission denied' });
  });

  it('does NOT call logAction when Supabase errors', async () => {
    eqMock.mockReturnValueOnce({
      then: (cb: (r: { data: null; error: { message: string } }) => unknown) =>
        cb({ data: null, error: { message: 'boom' } }),
    });
    await expect(
      promoteToTicket('row-err2', { category: 'support', owner_email: 'a@b.io' }),
    ).rejects.toThrow();
    expect(logAction).not.toHaveBeenCalled();
  });
});

describe('setInboxDisposition error path', () => {
  it('throws and does not log on Supabase failure', async () => {
    eqMock.mockReturnValueOnce({
      then: (cb: (r: { data: null; error: { message: string } }) => unknown) =>
        cb({ data: null, error: { message: 'denied' } }),
    });
    await expect(setInboxDisposition('row-err3', 'sales'))
      .rejects.toMatchObject({ message: 'denied' });
    expect(logAction).not.toHaveBeenCalled();
  });
});

describe('useInbox query shape', () => {
  it('filters kind=conversation by default', async () => {
    renderHook(() => useInbox());
    await waitFor(() => {
      const eqCalls = selectChainCalls.filter(c => c.method === 'eq');
      expect(eqCalls).toContainEqual({ method: 'eq', args: ['kind', 'conversation'] });
    });
  });

  it('adds is(inbox_disposition, null) when disposition=untriaged', async () => {
    renderHook(() => useInbox('untriaged'));
    await waitFor(() => {
      const isCalls = selectChainCalls.filter(c => c.method === 'is');
      expect(isCalls).toContainEqual({ method: 'is', args: ['inbox_disposition', null] });
    });
  });

  it('adds eq(inbox_disposition, sales) when disposition=sales', async () => {
    renderHook(() => useInbox('sales'));
    await waitFor(() => {
      const eqCalls = selectChainCalls.filter(c => c.method === 'eq');
      expect(eqCalls).toContainEqual({ method: 'eq', args: ['inbox_disposition', 'sales'] });
    });
  });

  it('does NOT add disposition filter when disposition=all', async () => {
    renderHook(() => useInbox('all'));
    await waitFor(() => {
      const eqCalls = selectChainCalls.filter(c => c.method === 'eq');
      // kind=conversation present, but no inbox_disposition= eq
      expect(eqCalls.some(c => (c.args as string[])[0] === 'inbox_disposition')).toBe(false);
    });
  });
});
