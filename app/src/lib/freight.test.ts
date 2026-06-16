import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Supabase mock ────────────────────────────────────────────────────────────
// Use vi.hoisted so mocks are available when vi.mock factories are hoisted.
const { fromMock, updateMock, updateEqResults } = vi.hoisted(() => {
  // Track resolved values for each update().eq() call in sequence.
  const updateEqResults: Array<{ error: null | { message: string } }> = [];
  let callIdx = 0;

  const makeEqAfterUpdate = () => ({
    eq: vi.fn(() => {
      const result = updateEqResults[callIdx] ?? { error: null };
      callIdx++;
      return Promise.resolve(result);
    }),
  });

  const updateMock = vi.fn(() => makeEqAfterUpdate());

  const eqMock: ReturnType<typeof vi.fn> = vi.fn();
  eqMock.mockImplementation(() => ({
    eq: eqMock,
    is: vi.fn().mockResolvedValue({ error: null }),
  }));
  const selectMock = vi.fn(() => ({
    eq: eqMock,
    order: vi.fn().mockResolvedValue({ data: [], error: null }),
  }));
  const insertMock = vi.fn().mockResolvedValue({
    data: [{ id: 'q-1', selected: false }],
    error: null,
  });
  const fromMock = vi.fn((_table: string) => ({
    select: selectMock,
    insert: insertMock,
    update: updateMock,
    eq: eqMock,
  }));

  return { fromMock, updateMock, updateEqResults };
});

vi.mock('./supabase', () => ({
  supabase: {
    from: fromMock,
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } } }),
    },
  },
}));
vi.mock('./activityLog', () => ({ logAction: vi.fn().mockResolvedValue(undefined) }));

import { selectQuote } from './freight';

describe('selectQuote', () => {
  beforeEach(() => {
    fromMock.mockClear();
    updateMock.mockClear();
    updateEqResults.length = 0;
    // Reset call index by re-assigning a fresh counter inside updateMock
    let callIdx = 0;
    updateMock.mockImplementation(() => ({
      eq: vi.fn(() => {
        const result = updateEqResults[callIdx] ?? { error: null };
        callIdx++;
        return Promise.resolve(result);
      }),
    }));
  });

  it('sets selected=false on all sibling rows then selected=true on the target', async () => {
    await selectQuote('ord-1', 'q-target');

    expect(fromMock).toHaveBeenCalledWith('freight_quotes');
    const calls = updateMock.mock.calls as unknown[][];
    expect(calls[0][0]).toEqual({ selected: false });
    expect(calls[1][0]).toEqual({ selected: true });
  });

  it('throws when Supabase returns an error', async () => {
    updateEqResults.push({ error: { message: 'DB error' } });
    await expect(selectQuote('ord-1', 'q-target')).rejects.toThrow('DB error');
  });
});
