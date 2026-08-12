// Case photos are filed into two sections — "Context of the Case - Photos" and
// "Inspection Photos" — so an upload has to carry the section it was dropped
// into all the way to the row. If the category is ever dropped on the way to
// the insert, every photo silently lands back in one undifferentiated pile.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { insertMock, uploadMock, state } = vi.hoisted(() => {
  const state: { inserted: any } = { inserted: null };
  const insertMock = vi.fn((row: any) => {
    state.inserted = row;
    return { select: () => ({ single: () => Promise.resolve({ data: row, error: null }) }) };
  });
  const uploadMock = vi.fn(() => Promise.resolve({ error: null }));
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

import { uploadReturnAttachment, RETURN_ATTACH_CATEGORIES } from './postShipment';

const png = () => new File([new Uint8Array([1, 2, 3])], 'shot.png', { type: 'image/png' });

describe('return attachment categories', () => {
  beforeEach(() => { state.inserted = null; insertMock.mockClear(); });

  it('exposes exactly the two operator-facing photo sections', () => {
    expect(RETURN_ATTACH_CATEGORIES.map(c => c.value)).toEqual(['context', 'inspection']);
    expect(RETURN_ATTACH_CATEGORIES.map(c => c.label)).toEqual([
      'Context of the Case - Photos',
      'Inspection Photos',
    ]);
  });

  it('files an upload into the section it was given', async () => {
    await uploadReturnAttachment('ret-1', png(), 'inspection');
    expect(state.inserted.category).toBe('inspection');
  });

  it('defaults to the context section when no section is named', async () => {
    await uploadReturnAttachment('ret-1', png());
    expect(state.inserted.category).toBe('context');
  });
});
