// A refund card must actually move when an approver moves it.
//
// Prod incident 2026-08-13 (Joseph Thavundayil, card 5cf5ab8a): George clicked
// "Approve as Manager" three times in three minutes. All three PATCHes returned
// 204 — every one of them wrote status='finance_review' to the DB. The board
// never moved, so as far as he could tell the card was stuck in Manager Review.
//
// Two defects behind that, both pinned here:
//
//   1. useRefundApprovals() fetches once on mount and is then driven ONLY by
//      realtime. A dropped socket (the edge logs show it reconnecting three
//      times across those same minutes) loses every change that happened in the
//      gap — permanently, since nothing ever re-reads. The board is stale until
//      a page reload, and no caller refetches after a write either.
//
//   2. managerApprove() had no stage guard, unlike submitToManager() and
//      financeApprove() which both check status first. So re-clicking a card
//      the board only *looked* stuck on silently re-approved it, restamping
//      manager_approved_at, instead of saying "this already happened".
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const { fromMock, channelMock, removeChannelMock, state } = vi.hoisted(() => {
  const state: {
    approval: any; ret: any;
    updateCalled: boolean; updatePatch: any;
    rows: any[]; listReads: number;
    subscribeCb: ((s: string) => void) | null;
    removed: any[]; unsubscribed: number;
  } = {
    approval: null, ret: null,
    updateCalled: false, updatePatch: null,
    rows: [], listReads: 0,
    subscribeCb: null, removed: [], unsubscribed: 0,
  };

  const fromMock = vi.fn((table: string) => ({
    select: (_cols?: string) => ({
      // List read — useRefundApprovals().
      order: (_col: string, _opts?: any) => {
        state.listReads += 1;
        return Promise.resolve({ data: state.rows, error: null });
      },
      // Single-row read — the stage mutations.
      eq: (_col: string, _val: string) => ({
        single: () => Promise.resolve(
          table === 'refund_approvals'
            ? { data: state.approval, error: state.approval ? null : { message: 'not found' } }
            : { data: state.ret, error: state.ret ? null : { message: 'not found' } },
        ),
      }),
    }),
    update: (patch: any) => ({
      eq: (_col: string, _val: string) => {
        state.updateCalled = true;
        state.updatePatch = patch;
        return Promise.resolve({ error: null });
      },
    }),
  }));

  const channel: any = {
    on: vi.fn(() => channel),
    subscribe: vi.fn((cb?: (s: string) => void) => { state.subscribeCb = cb ?? null; return channel; }),
    unsubscribe: vi.fn(() => { state.unsubscribed += 1; }),
  };
  const channelMock = vi.fn(() => channel);
  const removeChannelMock = vi.fn((c: any) => { state.removed.push(c); });

  return { fromMock, channelMock, removeChannelMock, state };
});

vi.mock('./supabase', () => ({
  supabase: {
    from: fromMock,
    channel: channelMock,
    removeChannel: removeChannelMock,
    auth: {
      getSession: () => Promise.resolve({ data: { session: { user: { id: 'mgr-1' } } } }),
      getUser: () => Promise.resolve({ data: { user: { id: 'mgr-1' } } }),
    },
  },
}));
vi.mock('./activityLog', () => ({ logAction: vi.fn(() => Promise.resolve()) }));

import { managerApprove, useRefundApprovals } from './postShipment';

beforeEach(() => {
  state.approval = null;
  state.ret = null;
  state.updateCalled = false;
  state.updatePatch = null;
  state.rows = [];
  state.listReads = 0;
  state.subscribeCb = null;
  state.removed = [];
  state.unsubscribed = 0;
  vi.clearAllMocks();
});

// ── Defect 2: the missing stage guard ───────────────────────────────────────
describe('managerApprove — stage guard', () => {
  it('approves a card sitting in Manager Review', async () => {
    state.approval = { id: 'r1', return_id: null, status: 'manager_review' };

    await managerApprove('r1', 'Yes');
    expect(state.updateCalled).toBe(true);
    expect(state.updatePatch.status).toBe('finance_review');
  });

  it('refuses a card that has already been approved through to Finance Review', async () => {
    // The exact prod case: a stale board still shows the card in Manager
    // Review, so the approver clicks again. That must report what happened,
    // not silently restamp the approval.
    state.approval = { id: 'r1', return_id: null, status: 'finance_review' };

    await expect(managerApprove('r1')).rejects.toThrow(/finance_review/);
    expect(state.updateCalled).toBe(false);
  });

  it.each(['submitted', 'refund_queue', 'refunded', 'denied', 'closed'])(
    'refuses a card in "%s"', async (status) => {
      state.approval = { id: 'r1', return_id: null, status };

      await expect(managerApprove('r1')).rejects.toThrow(new RegExp(status));
      expect(state.updateCalled).toBe(false);
    },
  );
});

// ── Defect 1: the board has to be able to re-read ───────────────────────────
describe('useRefundApprovals — keeping the board in sync', () => {
  it('loads the current rows on mount', async () => {
    state.rows = [{ id: 'r1', status: 'manager_review' }];

    const { result } = renderHook(() => useRefundApprovals());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.approvals).toHaveLength(1);
    expect(state.listReads).toBe(1);
  });

  it('does not spend a second read on the initial channel join', async () => {
    state.rows = [{ id: 'r1', status: 'manager_review' }];
    const { result } = renderHook(() => useRefundApprovals());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => { state.subscribeCb!('SUBSCRIBED'); });

    // The mount fetch is already current — rejoining is what needs a re-read.
    expect(state.listReads).toBe(1);
  });

  it('re-reads when the channel rejoins after the socket drops', async () => {
    state.rows = [{ id: 'r1', status: 'manager_review' }];
    const { result } = renderHook(() => useRefundApprovals());
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => { state.subscribeCb!('SUBSCRIBED'); });

    // Socket drops. The approval lands while nobody is listening, so the
    // postgres_changes event for it is never delivered. Then the client rejoins.
    state.rows = [{ id: 'r1', status: 'finance_review' }];
    await act(async () => { state.subscribeCb!('CLOSED'); });
    await act(async () => { state.subscribeCb!('SUBSCRIBED'); });

    await waitFor(() => expect(state.listReads).toBe(2));
    expect(result.current.approvals[0].status).toBe('finance_review');
  });

  it('exposes refresh() so a caller can re-read straight after a write', async () => {
    state.rows = [{ id: 'r1', status: 'manager_review' }];
    const { result } = renderHook(() => useRefundApprovals());
    await waitFor(() => expect(result.current.loading).toBe(false));

    state.rows = [{ id: 'r1', status: 'finance_review' }];
    await act(async () => { await result.current.refresh(); });

    expect(state.listReads).toBe(2);
    expect(result.current.approvals[0].status).toBe('finance_review');
  });

  it('removes the channel on unmount so a remount can rejoin the same topic', async () => {
    // unsubscribe() alone leaves the channel on the client, so a remount opens
    // a second channel on the same topic — and the duplicate join is what kills
    // realtime for the rest of the session.
    const { result, unmount } = renderHook(() => useRefundApprovals());
    await waitFor(() => expect(result.current.loading).toBe(false));

    unmount();

    expect(removeChannelMock).toHaveBeenCalledTimes(1);
  });
});
