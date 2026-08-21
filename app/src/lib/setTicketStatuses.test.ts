// setTicketStatuses derives the single `status` column (which open/closed,
// closed_at, SLA resolution and every open-queue count key off) from the
// multi-select set. Those derivation rules are the load-bearing part, so they
// get their own suite with a fully mocked Supabase.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  updateMock, eqMock, fromMock, logActionMock, cancelPendingMock, shipQueuedMock,
  selectMock, selectEqMock, maybeSingleMock, liveReplacementsMock,
} = vi.hoisted(() => ({
  updateMock: vi.fn(),
  eqMock: vi.fn(),
  fromMock: vi.fn(),
  logActionMock: vi.fn(() => Promise.resolve()),
  cancelPendingMock: vi.fn(() => Promise.resolve()),
  shipQueuedMock: vi.fn(() => Promise.resolve([] as string[])),
  // Reading the ticket's CURRENT statuses, for the queued-replacement lock.
  selectMock: vi.fn(),
  selectEqMock: vi.fn(),
  maybeSingleMock: vi.fn(),
  liveReplacementsMock: vi.fn(() => Promise.resolve([] as Array<{ id: string; order_ref: string }>)),
}));

vi.mock('./supabase', () => ({
  supabase: { from: fromMock, auth: { getUser: () => Promise.resolve({ data: { user: null } }) } },
}));
vi.mock('./activityLog', () => ({ logAction: logActionMock }));
vi.mock('./orders', () => ({
  cancelPendingReplacementsForTicket: cancelPendingMock,
  shipQueuedReplacementsForTicket: shipQueuedMock,
  liveReplacementsForTicket: liveReplacementsMock,
}));

import { setTicketStatuses, QueuedReplacementLockedError } from './service';

/** Pretend the stored ticket currently holds these statuses. */
function ticketHolds(status: string, tags: string[] = []) {
  maybeSingleMock.mockResolvedValue({ data: { status, tags }, error: null });
}

/** The patch object handed to supabase.update() for the last call. */
const patch = () => updateMock.mock.calls[0][0] as Record<string, unknown>;

describe('setTicketStatuses', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    eqMock.mockResolvedValue({ error: null });
    updateMock.mockReturnValue({ eq: eqMock });
    // Default: the ticket is not queued, so the lock never engages.
    maybeSingleMock.mockResolvedValue({ data: { status: 'waiting_on_us', tags: [] }, error: null });
    selectEqMock.mockReturnValue({ maybeSingle: maybeSingleMock });
    selectMock.mockReturnValue({ eq: selectEqMock });
    liveReplacementsMock.mockResolvedValue([]);
    fromMock.mockReturnValue({ update: updateMock, select: selectMock } as any);
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

// ── Queued-for-Replacement lock ────────────────────────────────────────────
// The tag is set automatically when a replacement order is created, so it must
// not be clearable by hand while that order is still live: the order is the
// source of truth for whether the customer is waiting on a unit. Two routes
// OUT stay open, because both resolve the order rather than orphaning it.
describe('setTicketStatuses — queued replacement lock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    eqMock.mockResolvedValue({ error: null });
    updateMock.mockReturnValue({ eq: eqMock });
    selectEqMock.mockReturnValue({ maybeSingle: maybeSingleMock });
    selectMock.mockReturnValue({ eq: selectEqMock });
    fromMock.mockReturnValue({ update: updateMock, select: selectMock } as any);
    liveReplacementsMock.mockResolvedValue([]);
    maybeSingleMock.mockResolvedValue({ data: { status: 'waiting_on_us', tags: [] }, error: null });
  });

  it('blocks a bare removal while an order is live, and writes nothing', async () => {
    ticketHolds('queued_for_replacement');
    liveReplacementsMock.mockResolvedValue([{ id: 'o1', order_ref: 'R-0042' }]);

    await expect(setTicketStatuses('t1', ['in_progress']))
      .rejects.toBeInstanceOf(QueuedReplacementLockedError);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('names the blocking orders in the error', async () => {
    ticketHolds('in_progress', ['queued_for_replacement']);
    liveReplacementsMock.mockResolvedValue([
      { id: 'o1', order_ref: 'R-0042' }, { id: 'o2', order_ref: 'R-0043' },
    ]);
    await expect(setTicketStatuses('t1', ['in_progress'])).rejects.toMatchObject({
      orderRefs: ['R-0042', 'R-0043'],
    });
  });

  it('detects the tag when it sits in tags rather than status', async () => {
    ticketHolds('waiting_on_us', ['queued_for_replacement']);
    liveReplacementsMock.mockResolvedValue([{ id: 'o1', order_ref: 'R-0042' }]);
    await expect(setTicketStatuses('t1', ['waiting_on_us']))
      .rejects.toBeInstanceOf(QueuedReplacementLockedError);
  });

  it('allows removal once the order is cancelled', async () => {
    ticketHolds('queued_for_replacement');
    liveReplacementsMock.mockResolvedValue([]);   // cancelled in Sales
    await setTicketStatuses('t1', ['in_progress']);
    expect(patch().status).toBe('in_progress');
    expect(patch().tags).toEqual([]);
  });

  // Escape hatch 1 — the unit went out. shipQueuedReplacementsForTicket hands
  // the order to Fulfillment, so nothing is orphaned.
  it('allows Replacement Sent even with a live order', async () => {
    ticketHolds('queued_for_replacement');
    liveReplacementsMock.mockResolvedValue([{ id: 'o1', order_ref: 'R-0042' }]);
    await setTicketStatuses('t1', ['replacement_sent']);
    expect(patch().status).toBe('replacement_sent');
    expect(shipQueuedMock).toHaveBeenCalledWith('t1');
  });

  // Escape hatch 2 — Complete cancels an awaiting replacement on the way out.
  it('allows Complete even with a live order', async () => {
    ticketHolds('queued_for_replacement');
    liveReplacementsMock.mockResolvedValue([{ id: 'o1', order_ref: 'R-0042' }]);
    await setTicketStatuses('t1', ['closed']);
    expect(patch().status).toBe('closed');
    expect(cancelPendingMock).toHaveBeenCalledWith('t1');
  });

  it('keeping the tag while editing other statuses is not a removal', async () => {
    ticketHolds('queued_for_replacement');
    liveReplacementsMock.mockResolvedValue([{ id: 'o1', order_ref: 'R-0042' }]);
    await setTicketStatuses('t1', ['queued_for_replacement', 'on_hold']);
    expect(patch().status).toBe('queued_for_replacement');
    expect(patch().tags).toEqual(['on_hold']);
  });

  it('does not pay for the lookup when the ticket was never queued', async () => {
    ticketHolds('waiting_on_us');
    await setTicketStatuses('t1', ['in_progress']);
    expect(liveReplacementsMock).not.toHaveBeenCalled();
    expect(patch().status).toBe('in_progress');
  });
});
