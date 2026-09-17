// A return case can leave the board without becoming a refund.
//
// The two Account-Manager columns — Return Form Submitted and Return &
// Inspection — are fed by a public form, so they collect test submissions,
// duplicates and forms filled in by mistake. Until now the only exits were
// forward (compile into a refund card) or a bare status dropdown that records
// no reason. Cancelling is open to everyone working the board; moving a real
// case forward is still the column owner's.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ReturnDetailModal } from '../RefundsTab';
import type { RefundParties } from '../../../lib/customers';
import type { ReturnRow, CaseUnitResolution } from '../../../lib/postShipment';

const stub = vi.hoisted(() => ({
  auth: { user: null, profile: null, role: null, loading: false },
  notes: { notes: [], loading: false, refresh: () => {} },
  attachments: { attachments: [], loading: false, refresh: () => {} },
  cancelReturn: vi.fn(async (_id: string, _reason: string) => {}),
}));

vi.mock('../../../lib/auth', () => ({ useAuth: () => stub.auth }));
vi.mock('../../../lib/postShipment', async (orig) => ({
  ...(await orig<typeof import('../../../lib/postShipment')>()),
  useCaseNotes: () => stub.notes,
  useCaseAttachments: () => stub.attachments,
  cancelReturnRequest: stub.cancelReturn,
}));

const parties: RefundParties = {
  purchaser: 'Gabriella Hottya', primaryUser: 'Gabriella Hottya', filer: 'Gabriella Hottya',
  samePerson: true, filerIsPurchaser: true, filerIsPrimaryUser: true,
};
const contact = { email: 'ghottya@yahoo.com', phone: '7864830997', address: '10350 W Bay Harbor Dr' };
const usage = { days: null, over30: null, onboardDate: null } as never;
const noCaseUnit: CaseUnitResolution =
  { serial: null, status: null, via: null, confirmed: false, others: [], conflictingName: null };

const returnRow = (over: Partial<ReturnRow> = {}): ReturnRow => ({
  id: 'ret-1',
  customer_name: 'Gabriella Hottya',
  customer_email: 'ghottya@yahoo.com',
  customer_phone: '7864830997',
  original_order_ref: '#1209',
  status: 'created',
  reason: 'Delay',
  created_at: '2026-09-01T12:00:00Z',
  ...over,
} as ReturnRow);

const noop = () => {};
const renderModal = (props: { canCancel?: boolean; r?: ReturnRow } = {}) => render(
  <ReturnDetailModal
    r={props.r ?? returnRow()}
    parties={parties}
    contact={contact}
    caseUnit={noCaseUnit}
    canOwn={false}
    canCancel={props.canCancel ?? true}
    usage={usage}
    invoices={[]}
    tickets={[]}
    onOpenTicket={noop}
    onCompile={noop}
    onError={noop}
    onClose={noop}
  />,
);

const cancelButton = () => screen.queryByRole('button', { name: /cancel request/i });

beforeEach(() => {
  stub.cancelReturn.mockReset();
  stub.cancelReturn.mockResolvedValue(undefined);
});

describe('cancelling a return case from the board', () => {
  it('offers the exit on a case still in Return Form Submitted', () => {
    renderModal({ r: returnRow({ status: 'created' }) });
    expect(cancelButton()).toBeTruthy();
  });

  it('offers it in Return & Inspection too', () => {
    renderModal({ r: returnRow({ status: 'received' }) });
    expect(cancelButton()).toBeTruthy();
  });

  it('does not offer it to someone who cannot move cards', () => {
    renderModal({ canCancel: false });
    expect(cancelButton()).toBeNull();
  });

  it('closes the return with the typed reason', async () => {
    renderModal({ r: returnRow({ status: 'received' }) });
    fireEvent.click(cancelButton()!);
    fireEvent.change(screen.getByPlaceholderText(/why/i), { target: { value: 'Duplicate of #1209' } });
    fireEvent.click(screen.getByRole('button', { name: /^confirm/i }));

    await waitFor(() => expect(stub.cancelReturn).toHaveBeenCalledWith('ret-1', 'Duplicate of #1209'));
  });
});
