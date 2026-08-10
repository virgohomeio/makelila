// setTicketStatuses derives the single `status` column (which open/closed,
// closed_at, SLA resolution and every open-queue count key off) from the
// multi-select set. Those derivation rules are the load-bearing part, so they
// get their own suite with a fully mocked Supabase.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { updateMock, eqMock, fromMock, logActionMock, cancelPendingMock } = vi.hoisted(() => ({
  updateMock: vi.fn(),
  eqMock: vi.fn(),
  fromMock: vi.fn(),
  logActionMock: vi.fn(() => Promise.resolve()),
  cancelPendingMock: vi.fn(() => Promise.resolve()),
}));

vi.mock('./supabase', () => ({
  supabase: { from: fromMock, auth: { getUser: () => Promise.resolve({ data: { user: null } }) } },
}));
vi.mock('./activityLog', () => ({ logAction: logActionMock }));
vi.mock('./orders', () => ({ cancelPendingReplacementsForTicket: cancelPendingMock }));

import { setTicketStatuses } from './service';

/** The patch object handed to supabase.update() for the last call. */
const patch = () => updateMock.mock.calls[0][0] as Record<string, unknown>;

describe('setTicketStatuses', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    eqMock.mockResolvedValue({ error: null });
    updateMock.mockReturnValue({ eq: eqMock });
    fromMock.mockReturnValue({ update: updateMock } as any);
  });

  it('stores the whole set in tags and mirrors the primary into status', async () => {
    await setTicketStatuses('t1', ['in_progress', 'queued_for_replacement']);
    expect(patch().tags).toEqual(['in_progress', 'queued_for_replacement']);
    // in_progress precedes queued_for_replacement in TICKET_STATUSES.
    expect(patch().status).toBe('in_progress');
  });

  it('normalizes to TICKET_STATUSES order regardless of click order', async () => {
    await setTicketStatuses('t1', ['on_hold', 'queued_for_replacement', 'in_progress']);
    expect(patch().tags).toEqual(['in_progress', 'queued_for_replacement', 'on_hold']);
    expect(patch().status).toBe('in_progress');
  });

  it('dedupes a status passed twice', async () => {
    await setTicketStatuses('t1', ['on_hold', 'on_hold']);
    expect(patch().tags).toEqual(['on_hold']);
  });

  it('falls back to Action Needed when every status is cleared', async () => {
    await setTicketStatuses('t1', []);
    expect(patch().status).toBe('waiting_on_us');
    expect(patch().tags).toEqual(['waiting_on_us']);
  });

  it('treats closed as exclusive — it clears the rest', async () => {
    await setTicketStatuses('t1', ['in_progress', 'queued_for_replacement', 'closed']);
    expect(patch().status).toBe('closed');
    expect(patch().tags).toEqual(['closed']);
  });

  it('stamps closed_at on close and cancels a queued replacement', async () => {
    await setTicketStatuses('t1', ['closed']);
    expect(patch().closed_at).toEqual(expect.any(String));
    expect(cancelPendingMock).toHaveBeenCalledWith('t1');
  });

  it('clears closed_at when reopening, and cancels nothing', async () => {
    await setTicketStatuses('t1', ['in_progress']);
    expect(patch().closed_at).toBeNull();
    expect(cancelPendingMock).not.toHaveBeenCalled();
  });

  it('does not fail the status change when the auto-cancel errors', async () => {
    cancelPendingMock.mockRejectedValueOnce(new Error('boom'));
    await expect(setTicketStatuses('t1', ['closed'])).resolves.toBeUndefined();
  });

  it('logs the full set, not just the primary', async () => {
    await setTicketStatuses('t1', ['in_progress', 'queued_for_replacement']);
    expect(logActionMock).toHaveBeenCalledWith(
      'ticket_status_changed', 't1', 'in_progress, queued_for_replacement',
      { entityType: 'ticket', entityId: 't1' },
    );
  });

  it('throws when the update fails', async () => {
    eqMock.mockResolvedValue({ error: { message: 'rls' } });
    await expect(setTicketStatuses('t1', ['on_hold'])).rejects.toBeTruthy();
  });
});
