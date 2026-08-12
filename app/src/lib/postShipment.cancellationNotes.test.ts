// Notes on a cancellation request card.
//
// The case-note rule is that a note anchors to the longest-lived row of the
// case, so moving the card between columns can never lose it. A cancellation
// row qualifies: compiling it into a refund doesn't delete it, it flips to
// 'completed' and keeps a link to the refund. So notes typed on a cancellation
// card anchor to the CANCELLATION, and the refund card that comes out of it
// reads the same thread — no copying, and an uncompile can't strand them.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { insertMock, state } = vi.hoisted(() => {
  const state: { table: string | null; inserted: any } = { table: null, inserted: null };
  const insertMock = vi.fn();
  return { insertMock, state };
});

vi.mock('./supabase', () => ({
  supabase: {
    from: (table: string) => ({
      insert: (row: any) => { state.table = table; state.inserted = row; insertMock(row); return Promise.resolve({ error: null }); },
      select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { display_name: 'Reina' }, error: null }) }) }),
    }),
    auth: {
      getSession: () => Promise.resolve({ data: { session: { user: { id: 'u-1' } } } }),
      getUser: () => Promise.resolve({ data: { user: { id: 'u-1', email: 'reina@virgohome.io' } } }),
    },
  },
}));
vi.mock('./activityLog', () => ({ logAction: vi.fn(() => Promise.resolve()) }));

import {
  caseNoteAnchor, addCaseNote, cancellationForRefund, type OrderCancellation,
} from './postShipment';

describe('caseNoteAnchor', () => {
  it('anchors to the return when the case has one', () => {
    expect(caseNoteAnchor('refund-1', 'ret-1', 'canc-1')).toEqual({ table: 'return_notes', column: 'return_id', id: 'ret-1' });
  });

  // The cancellation outlives the refund row (uncompile deletes the refund but
  // never the cancellation), so it wins over the refund id.
  it('anchors to the cancellation over the refund when there is no return', () => {
    expect(caseNoteAnchor('refund-1', null, 'canc-1')).toEqual({ table: 'refund_notes', column: 'cancellation_id', id: 'canc-1' });
  });

  it('anchors to a bare cancellation, before any refund exists', () => {
    expect(caseNoteAnchor(null, null, 'canc-1')).toEqual({ table: 'refund_notes', column: 'cancellation_id', id: 'canc-1' });
  });

  it('falls back to the refund for a direct refund with no return or cancellation', () => {
    expect(caseNoteAnchor('refund-1', null, null)).toEqual({ table: 'refund_notes', column: 'refund_id', id: 'refund-1' });
  });

  it('has no anchor when the case is nothing at all', () => {
    expect(caseNoteAnchor(null, null, null)).toBeNull();
  });
});

describe('addCaseNote on a cancellation', () => {
  beforeEach(() => { state.table = null; state.inserted = null; insertMock.mockClear(); });

  // refund_id is omitted rather than nulled — an insert naming a column the
  // database doesn't have yet fails outright, and ordinary refund notes must
  // keep working if the app ships ahead of the migration.
  it('writes the note against the cancellation, not a refund', async () => {
    await addCaseNote(null, null, 'Customer confirmed by email; no unit shipped.', 'canc-1');
    expect(state.table).toBe('refund_notes');
    expect(state.inserted).toMatchObject({
      cancellation_id: 'canc-1',
      body: 'Customer confirmed by email; no unit shipped.',
    });
    expect('refund_id' in state.inserted).toBe(false);
  });

  it('leaves cancellation_id off an ordinary refund note', async () => {
    await addCaseNote('refund-1', null, 'note');
    expect(state.inserted).toMatchObject({ refund_id: 'refund-1' });
    expect('cancellation_id' in state.inserted).toBe(false);
  });

  it('still attributes the author', async () => {
    await addCaseNote(null, null, 'note', 'canc-1');
    expect(state.inserted).toMatchObject({ author_id: 'u-1', author_name: 'Reina' });
  });

  it('keeps writing to the return when the case has one', async () => {
    await addCaseNote('refund-1', 'ret-1', 'note', 'canc-1');
    expect(state.table).toBe('return_notes');
    expect(state.inserted).toMatchObject({ return_id: 'ret-1' });
  });

  it('refuses a note with nothing to anchor to', async () => {
    await expect(addCaseNote(null, null, 'note')).rejects.toThrow(/neither/i);
    expect(state.inserted).toBeNull();
  });
});

// The refund card has no column pointing back at its cancellation — the link is
// order_cancellations.refund_approval_id, one way. The board already loads every
// cancellation, so it resolves the back-link in memory.
describe('cancellationForRefund', () => {
  const rows = [
    { id: 'canc-1', refund_approval_id: 'refund-1' },
    { id: 'canc-2', refund_approval_id: null },
  ] as OrderCancellation[];

  it('finds the cancellation a refund was compiled from', () => {
    expect(cancellationForRefund(rows, 'refund-1')?.id).toBe('canc-1');
  });

  it('is null for a refund that came from a return', () => {
    expect(cancellationForRefund(rows, 'refund-9')).toBeNull();
  });

  it('is null when asked about no refund at all', () => {
    expect(cancellationForRefund(rows, null)).toBeNull();
  });
});
