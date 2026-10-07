// Guardrails on the notes of a refund case (Fulfillment → Refunds board).
//
// A case walks through six columns and each column has one owner. Notes are the
// running record of the case, so everyone must be able to READ the whole thread
// at every stage — but writing is scoped: only the owner of the column the card
// is sitting in right now may add a note, and only a note's own author may edit
// or delete it. Delete always asks first.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { CaseNotes, ownsRefundColumn, refundColumnOwnerLabel } from '../RefundsTab';
import type { CaseNote } from '../../../lib/postShipment';

const RED = 'rgb(197, 48, 48)';
const GREY = 'rgb(160, 174, 192)';

const stub = vi.hoisted(() => ({
  auth: { user: { id: 'u-reina' }, profile: null, role: null, loading: false },
  notes: [] as CaseNote[],
  refresh: vi.fn(),
  add: vi.fn(async () => {}),
  update: vi.fn(async () => {}),
  del: vi.fn(async () => {}),
}));

vi.mock('../../../lib/auth', () => ({ useAuth: () => stub.auth }));

vi.mock('../../../lib/postShipment', async (orig) => ({
  ...(await orig<typeof import('../../../lib/postShipment')>()),
  useCaseNotes: () => ({ notes: stub.notes, loading: false, refresh: stub.refresh }),
  addCaseNote: stub.add,
  updateCaseNote: stub.update,
  deleteCaseNote: stub.del,
}));

const note = (over: Partial<CaseNote> = {}): CaseNote => ({
  id: 'n1',
  body: 'Unit arrived scratched — photos filed.',
  author_id: 'u-reina',
  author_name: 'Reina George',
  created_at: '2026-08-13T15:03:17Z',
  source: 'return',
  ...over,
} as CaseNote);

const renderNotes = (canWrite: boolean) =>
  render(<CaseNotes returnId="r1" canWrite={canWrite} ownerLabel="George" onError={() => {}} />);

const addButton = () => screen.getByRole('button', { name: /^Add/ });
const noteRow = (body: string) => screen.getByText(body).parentElement as HTMLElement;

beforeEach(() => {
  stub.notes = [];
  stub.auth = { user: { id: 'u-reina' }, profile: null, role: null, loading: false };
  vi.clearAllMocks();
});

describe('column ownership map', () => {
  it('gives every column exactly the owner the team agreed on', () => {
    expect(ownsRefundColumn('reina@virgohome.io', 'intake')).toBe(true);
    expect(ownsRefundColumn('reina@virgohome.io', 'inspection')).toBe(true);
    expect(ownsRefundColumn('reina@virgohome.io', 'submitted')).toBe(true);
    expect(ownsRefundColumn('george@virgohome.io', 'manager_review')).toBe(true);
    expect(ownsRefundColumn('yueli@virgohome.io', 'finance_review')).toBe(true);
    expect(ownsRefundColumn('huayi@virgohome.io', 'finance_review')).toBe(true);
    expect(ownsRefundColumn('pedrum@virgohome.io', 'refund_queue')).toBe(true);
  });

  it('does not let one column owner write in another owner’s column', () => {
    expect(ownsRefundColumn('reina@virgohome.io', 'manager_review')).toBe(false);
    expect(ownsRefundColumn('george@virgohome.io', 'finance_review')).toBe(false);
    expect(ownsRefundColumn('huayi@virgohome.io', 'submitted')).toBe(false);
    expect(ownsRefundColumn('pedrum@virgohome.io', 'manager_review')).toBe(false);
    expect(ownsRefundColumn(null, 'submitted')).toBe(false);
  });

  it('names the owner in plain words for the locked-card hint', () => {
    expect(refundColumnOwnerLabel('submitted')).toBe('Reina');
    expect(refundColumnOwnerLabel('manager_review')).toBe('George');
    expect(refundColumnOwnerLabel('finance_review')).toBe('Julie / Huayi');
    expect(refundColumnOwnerLabel('refund_queue')).toBe('Pedrum');
  });

  // Refunded / Denied are where a case comes to rest — nobody works them, so
  // their notes stay readable and stop being editable.
  it('leaves the terminal columns ownerless', () => {
    expect(refundColumnOwnerLabel('refunded')).toBe('');
    expect(refundColumnOwnerLabel('denied')).toBe('');
    expect(ownsRefundColumn('george@virgohome.io', 'refunded')).toBe(false);
  });
});

describe('reading notes', () => {
  it('shows every note to everyone, including on a card in someone else’s column', () => {
    stub.notes = [
      note({ id: 'n1', body: 'Reina: unit received.', author_id: 'u-reina', author_name: 'Reina' }),
      note({ id: 'n2', body: 'George: approved on the call.', author_id: 'u-george', author_name: 'George' }),
    ];
    renderNotes(false);
    expect(screen.getByText('Reina: unit received.')).toBeTruthy();
    expect(screen.getByText('George: approved on the call.')).toBeTruthy();
  });
});

describe('adding a note', () => {
  it('is red and works in a column the user owns', async () => {
    renderNotes(true);
    expect(addButton().style.backgroundColor).toBe(RED);
    fireEvent.change(screen.getByLabelText('New note'), { target: { value: 'Refund issued.' } });
    fireEvent.click(addButton());
    expect(stub.add).toHaveBeenCalledWith(null, 'r1', 'Refund issued.', null);
  });

  it('is grey, disabled, and says who owns the card when the column is not the user’s', () => {
    renderNotes(false);
    const btn = addButton();
    expect(btn.style.color).toBe(GREY);
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText('New note') as HTMLTextAreaElement).disabled).toBe(true);
    expect(screen.getByText(/George owns this column/)).toBeTruthy();
  });

  it('never writes when the column is not the user’s, even if the note box is filled', () => {
    renderNotes(false);
    fireEvent.change(screen.getByLabelText('New note'), { target: { value: 'sneaky' } });
    fireEvent.click(addButton());
    expect(stub.add).not.toHaveBeenCalled();
  });
});

describe('editing and deleting a note', () => {
  it('is red for the author while the card sits in their column', () => {
    stub.notes = [note()];
    renderNotes(true);
    const row = noteRow(stub.notes[0].body);
    expect(within(row).getByRole('button', { name: 'edit' }).style.color).toBe(RED);
    expect(within(row).getByRole('button', { name: 'delete' }).style.color).toBe(RED);
  });

  it('is grey for the author once the card has moved to someone else’s column', () => {
    stub.notes = [note()];
    renderNotes(false);
    const row = noteRow(stub.notes[0].body);
    const edit = within(row).getByRole('button', { name: 'edit' }) as HTMLButtonElement;
    const del = within(row).getByRole('button', { name: 'delete' }) as HTMLButtonElement;
    expect(edit.style.color).toBe(GREY);
    expect(del.style.color).toBe(GREY);
    expect(edit.disabled).toBe(true);
    expect(del.disabled).toBe(true);
  });

  it('is grey on someone else’s note even in a column the user owns', () => {
    stub.notes = [note({ author_id: 'u-george', author_name: 'George Kim' })];
    renderNotes(true);
    const row = noteRow(stub.notes[0].body);
    const del = within(row).getByRole('button', { name: 'delete' }) as HTMLButtonElement;
    expect(del.style.color).toBe(GREY);
    expect(del.disabled).toBe(true);
    expect(del.title).toBe('Only George Kim can edit or delete this note');
  });

  it('opens the edit box for the author and saves through updateCaseNote', () => {
    stub.notes = [note()];
    renderNotes(true);
    fireEvent.click(within(noteRow(stub.notes[0].body)).getByRole('button', { name: 'edit' }));
    fireEvent.change(screen.getByLabelText('Edit note'), { target: { value: 'Corrected wording.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(stub.update).toHaveBeenCalledWith(stub.notes[0], null, 'r1', 'Corrected wording.', null);
  });
});

describe('delete confirmation', () => {
  it('asks before removing anything', () => {
    stub.notes = [note()];
    renderNotes(true);
    fireEvent.click(within(noteRow(stub.notes[0].body)).getByRole('button', { name: 'delete' }));
    expect(stub.del).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Confirm delete note' })).toBeTruthy();
  });

  it('deletes only after the confirm step', () => {
    stub.notes = [note()];
    renderNotes(true);
    fireEvent.click(within(noteRow(stub.notes[0].body)).getByRole('button', { name: 'delete' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }));
    expect(stub.del).toHaveBeenCalledWith(stub.notes[0], null, 'r1', null);
  });

  it('keeps the note when the confirm is cancelled', () => {
    stub.notes = [note()];
    renderNotes(true);
    fireEvent.click(within(noteRow(stub.notes[0].body)).getByRole('button', { name: 'delete' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(stub.del).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText(stub.notes[0].body)).toBeTruthy();
  });
});
