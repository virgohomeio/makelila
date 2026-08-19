// setTicketStatuses derives the single `status` column (which open/closed,
// closed_at, SLA resolution and every open-queue count key off) from the
// multi-select set. Those derivation rules are the load-bearing part, so they
// get their own suite with a fully mocked Supabase.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { updateMock, eqMock, fromMock, logActionMock, cancelPendingMock, shipQueuedMock } = vi.hoisted(() => ({
  updateMock: vi.fn(),
  eqMock: vi.fn(),
  fromMock: vi.fn(),
  logActionMock: vi.fn(() => Promise.resolve()),
  cancelPendingMock: vi.fn(() => Promise.resolve()),
  shipQueuedMock: vi.fn(() => Promise.resolve([] as string[])),
}));

vi.mock('./supabase', () => ({
  supabase: { from: fromMock, auth: { getUser: () => Promise.resolve({ data: { user: null } }) } },
}));
vi.mock('./activityLog', () => ({ logAction: logActionMock }));
vi.mock('./orders', () => ({
  cancelPendingReplacementsForTicket: cancelPendingMock,
  shipQueuedReplacementsForTicket: shipQueuedMock,
}));

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

  // The primary lives in `status`; `tags` holds only the extras. If the primary
  // were in both, a bare `status` write from the Gmail sync or the reclassifier
  // would strand the old primary in `tags` as a phantom extra status.
  it('puts the primary in status and only the EXTRAS in tags', async () => {
    await setTicketStatuses('t1', ['in_progress', 'queued_for_replacement']);
    // in_progress precedes queued_for_replacement in TICKET_STATUSES.
    expect(patch().status).toBe('in_progress');
    expect(patch().tags).toEqual(['queued_for_replacement']);
  });

  it('leaves tags empty for a single status', async () => {
    await setTicketStatuses('t1', ['on_hold']);
    expect(patch().status).toBe('on_hold');
    expect(patch().tags).toEqual([]);
  });

  it('normalizes to TICKET_STATUSES order regardless of click order', async () => {
    await setTicketStatuses('t1', ['on_hold', 'queued_for_replacement', 'in_progress']);
    expect(patch().status).toBe('in_progress');
    expect(patch().tags).toEqual(['queued_for_replacement', 'on_hold']);
  });

  it('dedupes a status passed twice', async () => {
    await setTicketStatuses('t1', ['on_hold', 'on_hold']);
    expect(patch().status).toBe('on_hold');
    expect(patch().tags).toEqual([]);
  });

  it('falls back to Action Needed when every status is cleared', async () => {
    await setTicketStatuses('t1', []);
    expect(patch().status).toBe('waiting_on_us');
    expect(patch().tags).toEqual([]);
  });

  it('treats closed as exclusive — it clears the rest', async () => {
    await setTicketStatuses('t1', ['in_progress', 'queued_for_replacement', 'closed']);
    expect(patch().status).toBe('closed');
    expect(patch().tags).toEqual([]);
  });

  it('ranks return_refund above the scheduling states but below in_progress', async () => {
    await setTicketStatuses('t1', ['on_hold', 'return_refund', 'call_scheduled']);
    expect(patch().status).toBe('return_refund');
    expect(patch().tags).toEqual(['call_scheduled', 'on_hold']);

    await setTicketStatuses('t2', ['return_refund', 'in_progress']);
    expect(updateMock.mock.calls[1][0].status).toBe('in_progress');
    expect(updateMock.mock.calls[1][0].tags).toEqual(['return_refund']);
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

  // Was previously swallowed to a console.warn so a failure here couldn't fail
  // the close. That hid the failure completely and left the replacement order
  // sitting in Sales › Orders › Replacement — the drift this whole path exists
  // to prevent, and the reason 15 closed-ticket replacements were still in the
  // tab. Now it surfaces, matching the 'replacement_sent' branch: the status
  // write has already landed, so the close is not undone, and the operator can
  // re-click because the hand-off is idempotent.
  it('surfaces an auto-cancel failure instead of swallowing it', async () => {
    cancelPendingMock.mockRejectedValueOnce(new Error('boom'));
    await expect(setTicketStatuses('t1', ['closed'])).rejects.toThrow('boom');
  });

  it('still writes the status before the auto-cancel can fail', async () => {
    cancelPendingMock.mockRejectedValueOnce(new Error('boom'));
    await expect(setTicketStatuses('t1', ['closed'])).rejects.toThrow();
    // The close landed in the DB even though the hand-off threw afterwards.
    expect(patch().status).toBe('closed');
    expect(patch().closed_at).toEqual(expect.any(String));
  });

  // "Replacement Sent" is the next state of the same thread as "Queued for
  // Replacement" — holding both would tell the operator the customer is still
  // waiting for something that already shipped.
  it('drops queued_for_replacement when replacement_sent is applied', async () => {
    await setTicketStatuses('t1', ['in_progress', 'queued_for_replacement', 'replacement_sent']);
    expect(patch().status).toBe('in_progress');
    expect(patch().tags).toEqual(['replacement_sent']);
  });

  it('ships the queued replacement when replacement_sent is applied', async () => {
    shipQueuedMock.mockResolvedValueOnce(['R-0042']);
    await setTicketStatuses('t1', ['replacement_sent']);
    expect(shipQueuedMock).toHaveBeenCalledWith('t1');
    expect(logActionMock).toHaveBeenCalledWith(
      'replacement_sent', 't1', 'R-0042 → Fulfillment queue (shipped)',
      { entityType: 'ticket', entityId: 't1' },
    );
  });

  it('ships nothing for a status change that does not include replacement_sent', async () => {
    await setTicketStatuses('t1', ['in_progress', 'queued_for_replacement']);
    expect(shipQueuedMock).not.toHaveBeenCalled();
  });

  // Unlike the close-time auto-cancel, this one is NOT best-effort: silently
  // swallowing it would leave the order sitting in Sales › Orders › Replacement
  // while the ticket claims it shipped.
  it('surfaces a failure to hand the replacement over to fulfillment', async () => {
    shipQueuedMock.mockRejectedValueOnce(new Error('rls'));
    await expect(setTicketStatuses('t1', ['replacement_sent'])).rejects.toThrow(/rls/);
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
