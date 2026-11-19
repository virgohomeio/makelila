// Case photos used to require a return: return_attachments.return_id was the
// only owner column, so a refund card with no return behind it — one born from
// a cancellation form, or opened by hand — could take notes but never photos.
// These tests pin the owner-resolution rule that fixes that:
//
//   a case WITH a return  → photos stay on the return (the Returns board and
//                           the refund card then show the same strip)
//   a case WITHOUT one    → photos hang off the refund itself
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { insertMock, uploadMock, state } = vi.hoisted(() => {
  const state: { inserted: any; uploadPath: string | null } = { inserted: null, uploadPath: null };
  const insertMock = vi.fn((row: any) => {
    state.inserted = row;
    return { select: () => ({ single: () => Promise.resolve({ data: row, error: null }) }) };
  });
  const uploadMock = vi.fn((path: string) => { state.uploadPath = path; return Promise.resolve({ error: null }); });
  return { insertMock, uploadMock, state };
});

vi.mock('./supabase', () => ({
  supabase: {
    from: () => ({ insert: insertMock }),
    storage: { from: () => ({ upload: uploadMock, remove: () => Promise.resolve({ error: null }) }) },
    auth: {
      getSession: () => Promise.resolve({ data: { session: { user: { id: 'u-1' } } } }),
      getUser: () => Promise.resolve({ data: { user: { id: 'u-1' } } }),
    },
  },
}));
vi.mock('./activityLog', () => ({ logAction: vi.fn(() => Promise.resolve()) }));

import { caseAttachmentOwner, uploadCaseAttachment } from './postShipment';

const png = () => new File([new Uint8Array([1, 2, 3])], 'shot.png', { type: 'image/png' });

describe('caseAttachmentOwner', () => {
  // The return wins when there is one: a return-born case already shows its
  // photos on the Returns board, and splitting them across two owner columns
  // would hide half of each strip from one of the two views.
  it('files against the return when the case has one', () => {
    expect(caseAttachmentOwner('refund-1', 'ret-1')).toEqual({ column: 'return_id', id: 'ret-1' });
  });

  it('falls back to the refund when there is no return', () => {
    expect(caseAttachmentOwner('refund-1', null)).toEqual({ column: 'refund_id', id: 'refund-1' });
  });

  it('works on a bare return, with no refund compiled yet', () => {
    expect(caseAttachmentOwner(null, 'ret-1')).toEqual({ column: 'return_id', id: 'ret-1' });
  });

  // Callers pass whatever the card has; an owner-less case must not silently
  // upload into a row that can never be read back.
  it('has no owner when the case is neither', () => {
    expect(caseAttachmentOwner(null, null)).toBeNull();
  });
});

describe('uploadCaseAttachment', () => {
  beforeEach(() => { state.inserted = null; state.uploadPath = null; insertMock.mockClear(); });

  // The unused owner column is OMITTED, not sent as null: naming a column the
  // database doesn't have yet fails the whole insert, so an explicit null would
  // break existing return-owned uploads if the app shipped before the migration.
  it('stamps return_id and never mentions refund_id for a return-owned case', async () => {
    await uploadCaseAttachment({ refundId: 'refund-1', returnId: 'ret-1' }, png(), 'inspection');
    expect(state.inserted).toMatchObject({ return_id: 'ret-1', category: 'inspection' });
    expect('refund_id' in state.inserted).toBe(false);
  });

  it('stamps refund_id and never mentions return_id for a cancellation-born card', async () => {
    await uploadCaseAttachment({ refundId: 'refund-1', returnId: null }, png(), 'context');
    expect(state.inserted).toMatchObject({ refund_id: 'refund-1', category: 'context' });
    expect('return_id' in state.inserted).toBe(false);
  });

  // Storage paths are the only thing that tells the two apart in the bucket.
  it('namespaces the stored file under the owner it belongs to', async () => {
    await uploadCaseAttachment({ refundId: 'refund-1', returnId: null }, png());
    expect(state.uploadPath?.startsWith('refund-refund-1/')).toBe(true);

    await uploadCaseAttachment({ refundId: 'refund-1', returnId: 'ret-1' }, png());
    expect(state.uploadPath?.startsWith('ret-1/')).toBe(true);
  });

  it('refuses a case with nothing to hang the photo on', async () => {
    await expect(uploadCaseAttachment({ refundId: null, returnId: null }, png()))
      .rejects.toThrow(/no return or refund/i);
    expect(state.inserted).toBeNull();
  });

  it('still defaults to the context section', async () => {
    await uploadCaseAttachment({ refundId: 'refund-1', returnId: null }, png());
    expect(state.inserted.category).toBe('context');
  });
});
