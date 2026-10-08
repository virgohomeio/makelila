import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render as rtlRender, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';

type SaveLabelInput = { carrier: string; tracking_num: string; label_pdf?: File };

const {
  placementMock, saveLabelMock, sendMock, logActionMock,
  confirmMock, unconfirmMock, markSentMock,
} = vi.hoisted(() => ({
  placementMock: vi.fn(),
  confirmMock: vi.fn(
    (queueId: string, input: {
      carrier: string; tracking_num: string; label_pdf?: File; packing_list?: string | null;
    }) => {
      void queueId; void input;
      return Promise.resolve({ confirmed_at: '2026-09-29T18:00:00Z', label_pdf_path: null });
    },
  ),
  unconfirmMock: vi.fn((queueId: string) => { void queueId; return Promise.resolve(); }),
  markSentMock: vi.fn((queueId: string) => { void queueId; return Promise.resolve(); }),
  // Declared with its real signature so `mock.calls[0]` is typed and the
  // assertions below need no cast — a cast in a test file is a tsc -b failure
  // waiting to happen, and tsc -b is what gates the deploy.
  saveLabelMock: vi.fn(
    (queueId: string, input: { carrier: string; tracking_num: string; label_pdf?: File }) => {
      void queueId; void input;
      return Promise.resolve({ label_pdf_path: 'q-1/label-1.pdf' });
    },
  ),
  sendMock: vi.fn((queueId: string, override?: { subject: string; body: string; packing_list?: string }):
    Promise<{
      email_id: string; from?: string; sent_via?: 'gmail' | 'resend'; warning?: string;
      wording?: 'edited' | 'template'; packing_list?: 'edited' | 'template';
      attachments?: string[]; combined?: boolean;
      pesticide_worksheet?: 'signed' | 'unsigned' | 'not-required';
    }> => {
    void queueId; void override;
    return Promise.resolve({ email_id: 're_1' });
  }),
  logActionMock: vi.fn((..._args: unknown[]) => Promise.resolve()),
}));

vi.mock('../../../lib/eztrans', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/eztrans')>('../../../lib/eztrans');
  return {
    ...actual,
    useEzTransPlacements: placementMock,
    saveEzTransLabel: saveLabelMock,
    sendEzTransBooking: sendMock,
    // Pinned to the built-in default. Left real, this hook queries
    // email_templates over the network — which in a jsdom run rejects after
    // the test has finished and surfaces as an intermittent suite error.
    useEzTransTemplate: () => ({
      template: { subject: actual.DEFAULT_EZTRANS_SUBJECT, body: actual.DEFAULT_EZTRANS_BODY },
      packingList: actual.DEFAULT_EZTRANS_PACKING_LIST,
      source: 'built-in' as const,
      loading: false,
    }),
  };
});

// The day-batch writes go straight to Supabase, which does not exist in a
// jsdom run. Only the three mutations are stubbed — the filename helpers stay
// real, because what an attachment is called is part of what this panel
// promises the operator.
vi.mock('../../../lib/eztransBatch', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/eztransBatch')>('../../../lib/eztransBatch');
  return {
    ...actual,
    confirmEzTransOrder: confirmMock,
    unconfirmEzTransOrder: unconfirmMock,
    markEzTransSentOutsideBatch: markSentMock,
  };
});

vi.mock('../../../lib/activityLog', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/activityLog')>('../../../lib/activityLog');
  return {
    ...actual,
    logAction: logActionMock,
    useActivityForEntity: () => ({ entries: [], loading: false }),
  };
});

import { EzTransPanel } from '../queue/EzTransPanel';
import type { FulfillmentQueueRow } from '../../../lib/fulfillment';

// The panel links to the Templates tab, so it needs a router around it.
const render = (ui: ReactElement) => rtlRender(<MemoryRouter>{ui}</MemoryRouter>);

const row: FulfillmentQueueRow = {
  id: 'q-1', order_id: 'o-1', step: 3, assigned_serial: 'LL01-P100X-00412', assigned_serials: ['LL01-P100X-00412'],
  test_report_url: null, test_confirmed_at: null, test_confirmed_by: null,
  carrier: null, tracking_num: null,
  label_pdf_path: null, label_confirmed_at: null, label_confirmed_by: null,
  dock_printed: false, dock_affixed: false, dock_docked: false, dock_notified: false, dock_picked_up: false,
  dock_confirmed_at: null, dock_confirmed_by: null,
  starter_tracking_num: null, email_sent_at: null, email_sent_by: null,
  fulfilled_at: null, fulfilled_by: null, due_date: null, priority: false,
  created_at: '2026-09-18T00:00:00Z',
};

const order = {
  id: 'o-1', order_ref: '#1184',
  customer_name: 'Juanita M Wells',
  customer_email: 'juanita@example.com',
  customer_phone: '+17095551234',
  address_line: '14 Grenfell Drive', address_line2: null,
  city: 'Wabush', region_state: 'NL', postal_code: 'A0R 1B0',
  country: 'CA' as const,
};

const AT_EZTRANS = {
  placements: [{ serial: 'LL01-P100X-00412', skid: 'EZ-P01', pallet: 'P01', masterCarton: '1' }],
  offsite: [],
  loading: false,
};

function labelFile() {
  return new File(['%PDF-1.4'], 'goorooship-label.pdf', { type: 'application/pdf' });
}

function fillLabel() {
  fireEvent.change(screen.getByLabelText(/carrier/i), { target: { value: 'Purolator' } });
  fireEvent.change(screen.getByLabelText(/tracking number/i), { target: { value: 'PUR123456789' } });
  fireEvent.change(screen.getByLabelText(/shipping label pdf/i), { target: { files: [labelFile()] } });
}

const sendButton = () => screen.getByRole('button', { name: /send to cs@goorooship\.ca now/i });
const confirmButton = () => screen.getByRole('button', { name: /confirm carrier, tracking \+ packing list/i });

describe('EzTransPanel', () => {
  beforeEach(() => {
    placementMock.mockReset().mockReturnValue(AT_EZTRANS);
    saveLabelMock.mockClear();
    sendMock.mockClear();
    localStorage.clear();
    logActionMock.mockClear();
    confirmMock.mockClear();
    unconfirmMock.mockClear();
    markSentMock.mockClear();
  });

  it('stays out of the way for a unit that is not at EZ Trans', () => {
    placementMock.mockReturnValue({ placements: [], offsite: [], loading: false });
    const { container } = render(<EzTransPanel row={row} order={order} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('offers the Goorooship booking link for a unit that is', () => {
    render(<EzTransPanel row={row} order={order} />);
    expect(screen.getByRole('link', { name: /goorooship — book a shipment/i }))
      .toHaveAttribute('href', 'https://app.goorooship.ca/ship');
  });

  it('will not confirm or send until carrier, tracking and the label are all present', () => {
    render(<EzTransPanel row={row} order={order} />);
    expect(confirmButton()).toBeDisabled();
    expect(sendButton()).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/carrier/i), { target: { value: 'Purolator' } });
    expect(confirmButton()).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/tracking number/i), { target: { value: 'PUR123456789' } });
    expect(confirmButton()).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/shipping label pdf/i), { target: { files: [labelFile()] } });
    expect(confirmButton()).toBeEnabled();
    expect(sendButton()).toBeEnabled();
  });

  it('saves the label before sending, so the email attaches what the row holds', async () => {
    render(<EzTransPanel row={row} order={order} />);
    fillLabel();
    fireEvent.click(sendButton());

    // No second argument: an untouched email sends from the saved wording,
    // not from a copy the panel rendered.
    await waitFor(() => expect(sendMock).toHaveBeenCalledWith('q-1', undefined));
    expect(saveLabelMock).toHaveBeenCalledTimes(1);
    const [queueId, input]: [string, SaveLabelInput] = saveLabelMock.mock.calls[0];
    expect(queueId).toBe('q-1');
    expect(input.carrier).toBe('Purolator');
    expect(input.tracking_num).toBe('PUR123456789');
    expect(input.label_pdf?.name).toBe('goorooship-label.pdf');
    // Order matters: a send that beat the save would email the previous label.
    expect(saveLabelMock.mock.invocationCallOrder[0])
      .toBeLessThan(sendMock.mock.invocationCallOrder[0]);
  });

  it('hands the label details up so Confirm label does not ask for them again', async () => {
    const onLabelSaved = vi.fn();
    render(<EzTransPanel row={row} order={order} onLabelSaved={onLabelSaved} />);
    fillLabel();
    fireEvent.click(sendButton());
    await waitFor(() => expect(onLabelSaved).toHaveBeenCalledWith({
      carrier: 'Purolator', tracking_num: 'PUR123456789',
    }));
  });

  it('does not make the operator find the label file again on a second pass', () => {
    // A row rewound from step 4, or one where the first send failed: carrier,
    // tracking and the label are already on the row, so the send is unblocked
    // with nothing retyped and nothing re-uploaded.
    render(
      <EzTransPanel
        row={{ ...row, carrier: 'UPS', tracking_num: '1ZABC', label_pdf_path: 'q-1/label-0.pdf' }}
        order={order}
      />,
    );
    expect(screen.getByLabelText(/carrier/i)).toHaveValue('UPS');
    expect(screen.getByLabelText(/tracking number/i)).toHaveValue('1ZABC');
    expect(sendButton()).toBeEnabled();
    expect(screen.getByText(/already on this order/i)).toBeInTheDocument();
  });

  it('does not log a send that failed', async () => {
    sendMock.mockRejectedValueOnce(new Error('Resend 502'));
    render(<EzTransPanel row={row} order={order} />);
    fillLabel();
    fireEvent.click(sendButton());
    await waitFor(() => expect(screen.getByText(/Resend 502/)).toBeInTheDocument());
    expect(logActionMock).not.toHaveBeenCalled();
  });

  it('previews the email with the master carton read off the pallet', () => {
    render(<EzTransPanel row={row} order={order} />);
    fillLabel();
    fireEvent.click(screen.getByRole('button', { name: /preview \/ edit email \+ packing list/i }));
    expect(screen.getAllByText(/Master Carton: 1/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Tracking Number: PUR123456789/)).toBeInTheDocument();
  });

  it('sends the operator edit when the wording has been changed', async () => {
    render(<EzTransPanel row={row} order={order} />);
    fillLabel();
    fireEvent.click(screen.getByRole('button', { name: /preview \/ edit email \+ packing list/i }));
    fireEvent.click(screen.getByRole('button', { name: /edit this one/i }));
    fireEvent.change(screen.getByLabelText(/^body:$/i), {
      target: { value: 'Please expedite this one — customer is waiting.' },
    });
    fireEvent.click(sendButton());

    await waitFor(() => expect(sendMock).toHaveBeenCalledTimes(1));
    const [, override] = sendMock.mock.calls[0];
    expect(override?.body).toBe('Please expedite this one — customer is waiting.');
    // The subject was not touched, so it goes as rendered rather than blank.
    expect(override?.subject).toContain('#1184');
  });

  it('resets an edit back to the saved wording', () => {
    render(<EzTransPanel row={row} order={order} />);
    fillLabel();
    fireEvent.click(screen.getByRole('button', { name: /preview \/ edit email \+ packing list/i }));
    fireEvent.click(screen.getByRole('button', { name: /edit this one/i }));

    const bodyBox = screen.getByLabelText(/^body:$/i);
    const original = (bodyBox as HTMLTextAreaElement).value;
    expect(original).toContain('Hello EZ Trans team');

    fireEvent.change(bodyBox, { target: { value: 'scratch that' } });
    expect((screen.getByLabelText(/^body:$/i) as HTMLTextAreaElement).value).toBe('scratch that');

    fireEvent.click(screen.getByRole('button', { name: /reset to/i }));
    expect((screen.getByLabelText(/^body:$/i) as HTMLTextAreaElement).value).toBe(original);
  });

  it('leaves the packing list alone however the email is edited', () => {
    render(<EzTransPanel row={row} order={order} />);
    fillLabel();
    fireEvent.click(screen.getByRole('button', { name: /preview \/ edit email \+ packing list/i }));
    fireEvent.click(screen.getByRole('button', { name: /edit this one/i }));
    fireEvent.change(screen.getByLabelText(/^body:$/i), { target: { value: 'hi' } });

    // The packing-list preview still carries every field the pickers need.
    const list = screen.getByText(/PACKING LIST/).textContent ?? '';
    expect(list).toContain('Serial No: LL01-P100X-00412');
    expect(list).toContain('Master Carton: 1');
    expect(list).toContain('SKU: LILA-P100X');
  });
  it('lets the operator edit the packing list and sends what they wrote', async () => {
    render(<EzTransPanel row={row} order={order} />);
    fillLabel();
    fireEvent.click(screen.getByRole('button', { name: /preview \/ edit email \+ packing list/i }));
    fireEvent.click(screen.getByRole('button', { name: /edit packing list/i }));

    const box = screen.getByLabelText(/^packing list:$/i) as HTMLTextAreaElement;
    // Rendered, like the email editor above it — the operator edits the
    // document as the 3PL will read it, not a form full of placeholders.
    expect(box.value).toContain('# PACKING LIST');
    expect(box.value).toContain('Serial No: LL01-P100X-00412');
    expect(box.value).not.toContain('{{');

    fireEvent.change(box, { target: { value: '# PICK LIST\nHandle upright.\nSerial No: {{serial}}' } });
    fireEvent.click(sendButton());

    await waitFor(() => expect(sendMock).toHaveBeenCalledTimes(1));
    const [, override] = sendMock.mock.calls[0];
    expect(override?.packing_list).toBe('# PICK LIST\nHandle upright.\nSerial No: {{serial}}');
  });

  it('sends no packing-list override when only the wording was touched', async () => {
    render(<EzTransPanel row={row} order={order} />);
    fillLabel();
    fireEvent.click(screen.getByRole('button', { name: /preview \/ edit email \+ packing list/i }));
    fireEvent.click(screen.getByRole('button', { name: /edit this one/i }));
    fireEvent.change(screen.getByLabelText(/^body:$/i), { target: { value: 'hi' } });
    fireEvent.click(sendButton());

    await waitFor(() => expect(sendMock).toHaveBeenCalledTimes(1));
    // Absent, not a copy of the default: the server then reads the saved
    // template, so a packing list edited in Templates still wins.
    expect(sendMock.mock.calls[0][1]?.packing_list).toBeUndefined();
  });

  it('resets an edited packing list back to the saved one', () => {
    render(<EzTransPanel row={row} order={order} />);
    fillLabel();
    fireEvent.click(screen.getByRole('button', { name: /preview \/ edit email \+ packing list/i }));
    fireEvent.click(screen.getByRole('button', { name: /edit packing list/i }));

    const box = () => screen.getByLabelText(/^packing list:$/i) as HTMLTextAreaElement;
    const original = box().value;
    fireEvent.change(box(), { target: { value: 'scratch that' } });
    expect(box().value).toBe('scratch that');

    fireEvent.click(screen.getByRole('button', { name: /reset packing list/i }));
    expect(box().value).toBe(original);
  });

  it('keeps the two documents separate — an edited list leaves the wording alone', async () => {
    render(<EzTransPanel row={row} order={order} />);
    fillLabel();
    fireEvent.click(screen.getByRole('button', { name: /preview \/ edit email \+ packing list/i }));
    fireEvent.click(screen.getByRole('button', { name: /edit packing list/i }));
    fireEvent.change(screen.getByLabelText(/^packing list:$/i), { target: { value: '# PICK LIST' } });
    fireEvent.click(sendButton());

    await waitFor(() => expect(sendMock).toHaveBeenCalledTimes(1));
    const [, override] = sendMock.mock.calls[0];
    // Absent, not a copy of the rendered default — the same rule the packing
    // list has always followed. Sent, it is indistinguishable from an operator
    // edit, and the edge function would skip the email_templates lookup and
    // mail the built-in default over wording saved in the Templates tab.
    expect(override?.subject).toBeUndefined();
    expect(override?.body).toBeUndefined();
    expect(override?.packing_list).toBe('# PICK LIST');
  });

  it('does not claim a wording edit in the audit trail when only the list was touched', async () => {
    render(<EzTransPanel row={row} order={order} />);
    fillLabel();
    fireEvent.click(screen.getByRole('button', { name: /preview \/ edit email \+ packing list/i }));
    fireEvent.click(screen.getByRole('button', { name: /edit packing list/i }));
    fireEvent.change(screen.getByLabelText(/^packing list:$/i), { target: { value: '# PICK LIST' } });
    fireEvent.click(sendButton());

    await waitFor(() => expect(logActionMock).toHaveBeenCalledTimes(1));
    const detail = String(logActionMock.mock.calls[0][2]);
    expect(detail).toContain('packing list edited for this order');
    expect(detail).not.toContain('wording edited for this order');
  });

  it('records what the server actually used, not what the panel hoped', async () => {
    // "Did my edit go out?" has to be answerable from the activity trail. The
    // panel's own flags say what it meant to send; only the response says what
    // was used, and the two disagreeing is exactly the bug worth catching.
    sendMock.mockResolvedValueOnce({
      email_id: 're_1', wording: 'template', packing_list: 'template',
    });
    render(<EzTransPanel row={row} order={order} />);
    fillLabel();
    fireEvent.click(screen.getByRole('button', { name: /preview \/ edit email \+ packing list/i }));
    fireEvent.click(screen.getByRole('button', { name: /edit this one/i }));
    fireEvent.change(screen.getByLabelText(/^body:$/i), { target: { value: 'Please expedite.' } });
    fireEvent.click(sendButton());

    await waitFor(() => expect(logActionMock).toHaveBeenCalledTimes(1));
    expect(String(logActionMock.mock.calls[0][2])).not.toContain('wording edited for this order');
  });

  it('sends a cleared packing list rather than falling back to the stock one', async () => {
    render(<EzTransPanel row={row} order={order} />);
    fillLabel();
    fireEvent.click(screen.getByRole('button', { name: /preview \/ edit email \+ packing list/i }));
    fireEvent.click(screen.getByRole('button', { name: /edit packing list/i }));
    fireEvent.change(screen.getByLabelText(/^packing list:$/i), { target: { value: '' } });
    fireEvent.click(sendButton());

    await waitFor(() => expect(sendMock).toHaveBeenCalledTimes(1));
    expect(sendMock.mock.calls[0][1]?.packing_list).toBe('');
  });
  it('tells the operator when the booking went out from a different address', async () => {
    sendMock.mockResolvedValueOnce({
      email_id: 'e1',
      from: 'VCycene Team <support@lilacomposter.com>',
      warning: 'Sent from VCycene Team <support@lilacomposter.com> instead of ' +
        'VCycene Fulfillment <reina@virgohome.io>: virgohome.io is not a verified sending domain.',
    });
    render(<EzTransPanel row={row} order={order} />);
    fillLabel();
    fireEvent.click(sendButton());

    // Reported, not swallowed: the mail went, but not as the operator expects.
    expect(await screen.findByText(/not a verified sending domain/i)).toBeInTheDocument();
    // And it is on the record, not just on screen.
    await waitFor(() => expect(logActionMock).toHaveBeenCalled());
    const note = String(logActionMock.mock.calls.at(-1)?.[2] ?? '');
    expect(note).toMatch(/not a verified sending domain/i);
  });
  it('says the booking is in the sender\'s Sent folder when Gmail carried it', async () => {
    sendMock.mockResolvedValueOnce({
      email_id: 'g1',
      from: 'VCycene Fulfillment <reina@virgohome.io>',
      sent_via: 'gmail',
    });
    render(<EzTransPanel row={row} order={order} />);
    fillLabel();
    fireEvent.click(sendButton());

    expect(await screen.findByText(/in that mailbox's Sent folder/i)).toBeInTheDocument();
    await waitFor(() => expect(logActionMock).toHaveBeenCalled());
    expect(String(logActionMock.mock.calls.at(-1)?.[2] ?? ''))
      .toMatch(/in their Gmail Sent folder/i);
  });

  it('says plainly when there will be no Sent-folder copy', async () => {
    sendMock.mockResolvedValueOnce({
      email_id: 'r1',
      from: 'VCycene Team <support@lilacomposter.com>',
      sent_via: 'resend',
      warning: 'Sent through Resend, not Gmail, so there is no copy in reina@virgohome.io\'s Sent folder.',
    });
    render(<EzTransPanel row={row} order={order} />);
    fillLabel();
    fireEvent.click(sendButton());

    expect(await screen.findByText(/no copy in that mailbox's Sent folder/i)).toBeInTheDocument();
    expect(screen.getByText(/no copy in reina@virgohome\.io's Sent folder/i)).toBeInTheDocument();
  });
  it('shows the edited packing list in the preview, not the stock one', async () => {
    // Reported as "my edit was not included": the edit did reach the PDF, but
    // closing the editor dropped the preview back to the template, so the
    // panel showed the stock document as "Attached packing list (PDF)".
    render(<EzTransPanel row={row} order={order} />);
    fillLabel();
    fireEvent.click(screen.getByRole('button', { name: /preview \/ edit email \+ packing list/i }));
    fireEvent.click(screen.getByRole('button', { name: /edit packing list/i }));
    fireEvent.change(screen.getByLabelText(/^packing list:$/i), {
      target: { value: '# PACKING LIST\nFridge magnet: 1\nTote bag: 1' },
    });
    fireEvent.click(screen.getByRole('button', { name: /done editing/i }));

    const preview = screen.getByText(/PACKING LIST/).textContent ?? '';
    expect(preview).toContain('Fridge magnet: 1');
    expect(preview).toContain('Tote bag: 1');
    // And it is no longer claiming the stock contents.
    expect(preview).not.toContain('Batch/Lot Number');
  });
  it('reports back which packing list the server actually sent', async () => {
    sendMock.mockResolvedValueOnce({
      email_id: 'e2', wording: 'template', packing_list: 'edited',
    });
    render(<EzTransPanel row={row} order={order} />);
    fillLabel();
    fireEvent.click(sendButton());

    expect(await screen.findByText(/Packing list: your edit for this order/i)).toBeInTheDocument();
    expect(screen.getByText(/Wording: the saved template/i)).toBeInTheDocument();
  });
  it('does not carry one order\'s packing-list edit onto another order', () => {
    // The panel is rendered without a key, so switching orders in the queue
    // reuses the same component instance. An edit left in state would ride
    // across and put the wrong customer's document in front of the 3PL.
    const { rerender } = render(<EzTransPanel row={row} order={order} />);
    fillLabel();
    fireEvent.click(screen.getByRole('button', { name: /preview \/ edit email \+ packing list/i }));
    fireEvent.click(screen.getByRole('button', { name: /edit packing list/i }));
    fireEvent.change(screen.getByLabelText(/^packing list:$/i), {
      target: { value: '# PACKING LIST\nFridge magnet: 1' },
    });

    const otherRow = { ...row, id: 'q-other', order_id: 'o-other' };
    const otherOrder = { ...order, id: 'o-other', order_ref: '#9999' };
    rerender(<EzTransPanel row={otherRow} order={otherOrder} />);

    fireEvent.click(screen.getByRole('button', { name: /preview \/ edit email \+ packing list/i }));
    expect(screen.queryByText(/Fridge magnet: 1/)).not.toBeInTheDocument();
  });

  it('keeps a packing-list edit when the operator comes back to the order', () => {
    // "It doesn't save my changes": the draft lived only in component state, so
    // stepping away to another order and back lost the edit entirely.
    const { unmount } = render(<EzTransPanel row={row} order={order} />);
    fillLabel();
    fireEvent.click(screen.getByRole('button', { name: /preview \/ edit email \+ packing list/i }));
    fireEvent.click(screen.getByRole('button', { name: /edit packing list/i }));
    fireEvent.change(screen.getByLabelText(/^packing list:$/i), {
      target: { value: '# PACKING LIST\nFridge magnet: 1\nTote bag: 1' },
    });
    unmount();

    render(<EzTransPanel row={row} order={order} />);
    fireEvent.click(screen.getByRole('button', { name: /show edited email \+ packing list/i }));
    expect(screen.getByText(/Fridge magnet: 1/)).toBeInTheDocument();
    expect(screen.getByText(/Tote bag: 1/)).toBeInTheDocument();
  });
  it('keeps an edited subject and body when the operator comes back', () => {
    const { unmount } = render(<EzTransPanel row={row} order={order} />);
    fillLabel();
    fireEvent.click(screen.getByRole('button', { name: /preview \/ edit email \+ packing list/i }));
    fireEvent.click(screen.getByRole('button', { name: /edit this one/i }));
    fireEvent.change(screen.getByLabelText(/^subject:$/i), { target: { value: 'RUSH — #1184' } });
    fireEvent.change(screen.getByLabelText(/^body:$/i), { target: { value: 'Please expedite.' } });
    unmount();

    render(<EzTransPanel row={row} order={order} />);
    fireEvent.click(screen.getByRole('button', { name: /show edited email \+ packing list/i }));
    fireEvent.click(screen.getByRole('button', { name: /edit this one/i }));
    expect((screen.getByLabelText(/^subject:$/i) as HTMLInputElement).value).toBe('RUSH — #1184');
    expect((screen.getByLabelText(/^body:$/i) as HTMLTextAreaElement).value).toBe('Please expedite.');
  });

  it('sends the restored edits rather than the template', async () => {
    const { unmount } = render(<EzTransPanel row={row} order={order} />);
    fillLabel();
    fireEvent.click(screen.getByRole('button', { name: /preview \/ edit email \+ packing list/i }));
    fireEvent.click(screen.getByRole('button', { name: /edit this one/i }));
    fireEvent.change(screen.getByLabelText(/^body:$/i), { target: { value: 'Please expedite.' } });
    fireEvent.click(screen.getByRole('button', { name: /edit packing list/i }));
    fireEvent.change(screen.getByLabelText(/^packing list:$/i), {
      target: { value: '# PACKING LIST\nTote bag: 1' },
    });
    unmount();

    // A fresh panel for the same order, as if the operator had navigated away.
    // The carrier and tracking come back off the queue row in the real app;
    // this stub row carries neither, so they are re-entered here.
    render(<EzTransPanel row={row} order={order} />);
    fillLabel();
    fireEvent.click(sendButton());
    await waitFor(() => expect(sendMock).toHaveBeenCalledTimes(1));
    const [, override] = sendMock.mock.calls[0];
    expect(override?.body).toBe('Please expedite.');
    expect(override?.packing_list).toBe('# PACKING LIST\nTote bag: 1');
  });
  it('puts the order in today\u2019s batch with the label and the packing list', async () => {
    render(<EzTransPanel row={row} order={order} />);
    fillLabel();
    fireEvent.click(confirmButton());

    await waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(1));
    const [queueId, input] = confirmMock.mock.calls[0];
    expect(queueId).toBe('q-1');
    expect(input.carrier).toBe('Purolator');
    expect(input.tracking_num).toBe('PUR123456789');
    expect(input.label_pdf?.name).toBe('goorooship-label.pdf');
    // Null, not a copy of the rendered template: a copy stored on the row
    // would freeze today's wording and beat a later edit in the Templates tab.
    expect(input.packing_list).toBeNull();
    // Nothing is emailed by confirming — that is the whole point of the batch.
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('pins an edited packing list to the row so the evening send can read it', async () => {
    // The edit used to live only in this browser's localStorage, which an
    // end-of-day send from another machine could not see.
    render(<EzTransPanel row={row} order={order} />);
    fillLabel();
    fireEvent.click(screen.getByRole('button', { name: /preview \/ edit email \+ packing list/i }));
    fireEvent.click(screen.getByRole('button', { name: /edit packing list/i }));
    fireEvent.change(screen.getByLabelText(/^packing list:$/i), {
      target: { value: '# PICK LIST\nHandle upright.' },
    });
    fireEvent.click(confirmButton());

    await waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(1));
    expect(confirmMock.mock.calls[0][1].packing_list).toBe('# PICK LIST\nHandle upright.');
  });

  it('says the order is in today\u2019s batch, and names what will go with it', async () => {
    render(<EzTransPanel row={row} order={order} />);
    fillLabel();
    fireEvent.click(confirmButton());
    expect(await screen.findByText(/in today's batch since/i)).toBeInTheDocument();
    expect(screen.getByText(/label-and-packing-list-Juanita-M-Wells-PUR123456789\.pdf/))
      .toBeInTheDocument();
  });

  it('lets the operator pull an order back out of today\u2019s batch', async () => {
    const onBatchChanged = vi.fn();
    render(
      <EzTransPanel
        row={{ ...row, carrier: 'UPS', tracking_num: '1ZABC', label_pdf_path: 'q-1/l.pdf',
               eztrans_confirmed_at: '2026-09-29T18:00:00Z' }}
        order={order}
        onBatchChanged={onBatchChanged}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /remove from today's batch/i }));
    await waitFor(() => expect(unconfirmMock).toHaveBeenCalledWith('q-1'));
    expect(onBatchChanged).toHaveBeenCalled();
  });

  it('keeps an order mailed on its own out of the evening batch', async () => {
    // Both paths reach the same 3PL. A rush shipment sent from here must not
    // also ride along in the day's email, or the picker gets the same carton
    // twice.
    render(<EzTransPanel row={row} order={order} />);
    fillLabel();
    fireEvent.click(sendButton());
    await waitFor(() => expect(markSentMock).toHaveBeenCalledWith('q-1'));
  });

  it('does not report a failed bookkeeping write as a failed send', async () => {
    markSentMock.mockRejectedValueOnce(new Error('network error'));
    render(<EzTransPanel row={row} order={order} />);
    fillLabel();
    fireEvent.click(sendButton());
    // The email went. The warning says what did not.
    expect(await screen.findByText(/could not be marked as sent for the day batch/i))
      .toBeInTheDocument();
    expect(screen.getByText(/Confirmation, packing list and label sent/i)).toBeInTheDocument();
  });

  it('shows an order that already went out in a batch rather than offering it again', () => {
    render(
      <EzTransPanel
        row={{ ...row, carrier: 'UPS', tracking_num: '1ZABC', label_pdf_path: 'q-1/l.pdf',
               eztrans_confirmed_at: '2026-09-29T18:00:00Z',
               eztrans_batch_sent_at: '2026-09-29T21:00:00Z' }}
        order={order}
      />,
    );
    expect(screen.getByText(/Went out in the Goorooship batch of/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /remove from today's batch/i }))
      .not.toBeInTheDocument();
  });

  it('shows who is copied, so the recipient list is not a matter of faith', () => {
    render(<EzTransPanel row={row} order={order} />);
    const copied = screen.getByText(/reina@virgohome\.io/).textContent ?? '';
    expect(copied).toContain('huayi@virgohome.io');
    expect(copied).toContain('support@goorooship.ca');
    expect(copied).toContain('fulfillment@goorooship.ca');
  });
});

describe('the US pesticide worksheet', () => {
  // Same order, shipped across the border. The worksheet is decided by the
  // destination, not the carrier — #1270 and #1279 were both UPS and both got
  // the form; a US shipment on any other carrier used to get nothing.
  const usOrder = {
    ...order, city: 'Gahanna', region_state: 'OH', postal_code: '43230',
    country: 'US' as const,
  };

  beforeEach(() => {
    placementMock.mockReset().mockReturnValue(AT_EZTRANS);
    sendMock.mockClear();
    logActionMock.mockClear();
    confirmMock.mockClear();
    markSentMock.mockClear();
    localStorage.clear();
  });

  function fillUps() {
    fireEvent.change(screen.getByLabelText(/carrier/i), { target: { value: 'UPS' } });
    fireEvent.change(screen.getByLabelText(/tracking number/i), {
      target: { value: '1Z2985EADK93221574' },
    });
    fireEvent.change(screen.getByLabelText(/shipping label pdf/i), { target: { files: [labelFile()] } });
  }

  it('names one merged attachment on a domestic booking', () => {
    render(<EzTransPanel row={row} order={order} />);
    fillLabel();
    expect(screen.getByText('shipping-label-and-packing-list-1184.pdf')).toBeInTheDocument();
    expect(screen.queryByText(/pesticide/i)).not.toBeInTheDocument();
  });

  it('leaves it off a Canadian booking even on UPS', () => {
    render(<EzTransPanel row={row} order={order} />);
    fillUps();
    expect(screen.getByText('shipping-label-and-packing-list-1184.pdf')).toBeInTheDocument();
    expect(screen.queryByText(/pesticide/i)).not.toBeInTheDocument();
  });

  it('adds the worksheet to what is attached on a shipment to the US', () => {
    render(<EzTransPanel row={row} order={usOrder} />);
    fillUps();
    expect(screen.getByText(
      'shipping-label-and-packing-list-1184.pdf, pesticide-worksheet-1184.pdf',
    )).toBeInTheDocument();
    expect(screen.getByText(/This is a US entry/i)).toBeInTheDocument();
  });

  it('adds it on a US shipment that is not booked with UPS', () => {
    render(<EzTransPanel row={row} order={usOrder} />);
    fireEvent.change(screen.getByLabelText(/carrier/i), { target: { value: 'GLS' } });
    fireEvent.change(screen.getByLabelText(/tracking number/i), { target: { value: 'G1' } });
    fireEvent.change(screen.getByLabelText(/shipping label pdf/i), { target: { files: [labelFile()] } });
    expect(screen.getByText(
      'shipping-label-and-packing-list-1184.pdf, pesticide-worksheet-1184.pdf',
    )).toBeInTheDocument();
  });

  it('shows the fields the worksheet is tailored with, off this shipment', () => {
    render(<EzTransPanel row={row} order={usOrder} />);
    fillUps();
    fireEvent.click(screen.getByRole('button', { name: /preview \/ edit email \+ packing list/i }));
    expect(screen.getByText(/Attached US pesticide worksheet/i)).toBeInTheDocument();
    // The tracking number on the form is the one being filed, not a stale one.
    expect(screen.getAllByText('1Z2985EADK93221574').length).toBeGreaterThan(0);
    expect(screen.getByText('8509.80.5095')).toBeInTheDocument();
    expect(screen.getByText(/Huayi Gao/)).toBeInTheDocument();
  });

  it('tells the 3PL in the email body to upload the worksheet, not pack it', () => {
    // The whole point of the fix: #1270 and #1279 went out with the worksheet
    // attached and UPS held both entries, because the email read as a list of
    // things to print and tape to a carton.
    render(<EzTransPanel row={row} order={usOrder} />);
    fillUps();
    fireEvent.click(screen.getByRole('button', { name: /preview \/ edit email \+ packing list/i }));
    expect(screen.getByText(/pesticide worksheet \(FIFRA\) for this US entry/i))
      .toBeInTheDocument();
    expect(screen.getByText(/upload it to this shipment on Goorooship/i)).toBeInTheDocument();
    expect(screen.getByText(/Do not print it or tape it to the box/i)).toBeInTheDocument();
  });

  it('records an unsigned worksheet in the audit trail rather than letting it pass', async () => {
    // A US entry, so the worksheet is in play at all.
    sendMock.mockResolvedValueOnce({
      email_id: 're_2',
      attachments: ['shipping-label-and-packing-list-1184.pdf', 'pesticide-worksheet-1184.pdf'],
      combined: true,
      pesticide_worksheet: 'unsigned',
      warning: 'The pesticide worksheet went out UNSIGNED',
    });
    render(<EzTransPanel row={row} order={usOrder} />);
    fillUps();
    fireEvent.click(sendButton());
    await waitFor(() => expect(logActionMock).toHaveBeenCalled());
    const note = String(logActionMock.mock.calls[0][2]);
    expect(note).toContain('US pesticide worksheet');
    expect(note).toContain('worksheet UNSIGNED');
    expect(screen.getByText(/went out UNSIGNED/)).toBeInTheDocument();
  });

  it('says so when the label had to go as its own attachment', async () => {
    sendMock.mockResolvedValueOnce({
      email_id: 're_3',
      attachments: ['shipping-label-1184.pdf', 'packing-list-1184.pdf'],
      combined: false,
    });
    render(<EzTransPanel row={row} order={order} />);
    fillLabel();
    fireEvent.click(sendButton());
    await waitFor(() => expect(logActionMock).toHaveBeenCalled());
    expect(String(logActionMock.mock.calls[0][2]))
      .toContain('label and packing list sent separately');
    expect(screen.getByText(/Attached: shipping-label-1184.pdf, packing-list-1184.pdf/))
      .toBeInTheDocument();
  });
});

// M-0001 is three LILA Pros. The panel named one of them, so the operator had
// nothing on screen saying the other two were part of this shipment.
describe('an order for more than one machine', () => {
  const THREE_ROW: FulfillmentQueueRow = {
    ...row,
    assigned_serial: 'LL01-00000000397',
    assigned_serials: ['LL01-00000000397', 'LL01-00000000398', 'LL01-00000000400'],
  };
  const THREE = {
    placements: [
      { serial: 'LL01-00000000397', skid: 'EZ-P10', pallet: 'P10', masterCarton: '10' },
      { serial: 'LL01-00000000398', skid: 'EZ-P10', pallet: 'P10', masterCarton: '10' },
      { serial: 'LL01-00000000400', skid: 'EZ-P10', pallet: 'P10', masterCarton: '10' },
    ],
    offsite: [],
    loading: false,
  };

  beforeEach(() => {
    placementMock.mockReset().mockReturnValue(THREE);
  });

  it('says three machines are held, not one serial', () => {
    render(<EzTransPanel row={THREE_ROW} order={order} />);
    expect(screen.getByText(/3 machines are/i)).toBeInTheDocument();
  });

  it('lists every serial in the shipment facts', () => {
    render(<EzTransPanel row={THREE_ROW} order={order} />);
    for (const serial of THREE.placements.map(p => p.serial)) {
      expect(screen.getAllByText(new RegExp(serial)).length).toBeGreaterThan(0);
    }
    expect(screen.getByText('Quantity')).toBeInTheDocument();
  });

  it('puts all three on the email the 3PL receives', () => {
    render(<EzTransPanel row={THREE_ROW} order={order} />);
    fireEvent.click(screen.getByRole('button', { name: /preview \/ edit email \+ packing list/i }));
    // The rendered preview is the email, verbatim — the same text the send
    // posts, so asserting on it is asserting on what the 3PL opens.
    const previews = document.querySelectorAll('pre');
    const text = [...previews].map(el => el.textContent ?? '').join('\n');
    for (const serial of THREE.placements.map(p => p.serial)) {
      expect(text).toContain(serial);
    }
    expect(text).toContain('Quantity: 3');
  });

  // A split order is not one Goorooship shipment. Booking it would tell the
  // 3PL to pick a machine they do not hold, and the box would leave short with
  // nothing on any screen saying so.
  it('blocks the booking when one of the machines is not at EZ Trans', () => {
    placementMock.mockReturnValue({
      placements: THREE.placements.slice(0, 2),
      offsite: ['LL01-00000000400'],
      loading: false,
    });
    render(<EzTransPanel row={THREE_ROW} order={order} />);
    fillLabel();
    expect(screen.getByText(/not held at EZ Trans/i)).toBeInTheDocument();
    expect(screen.getByText(/LL01-00000000400/)).toBeInTheDocument();
    expect(sendButton()).toBeDisabled();
    expect(confirmButton()).toBeDisabled();
  });
});

// The compost starter ships from Amazon direct to the customer and never joins
// this carton — but once this email goes out the 3PL has the box, so this is
// the last moment anyone can notice the soil was never ordered. StepLabel works
// out the answer and hands it down, so the three buttons that can end step 3
// are gated by one fact rather than three.
describe('EzTransPanel — the starter blocks the Goorooship email too', () => {
  beforeEach(() => {
    placementMock.mockReset().mockReturnValue(AT_EZTRANS);
    saveLabelMock.mockClear();
    sendMock.mockClear();
    confirmMock.mockClear();
    localStorage.clear();
  });

  const STARTER_GAP = 'the compost starter ordered, with its Amazon tracking number';

  it('blocks both sends on a shipment whose starter was never ordered', () => {
    render(<EzTransPanel row={row} order={order} starterGap={STARTER_GAP} />);
    fillLabel();

    expect(confirmButton()).toBeDisabled();
    expect(sendButton()).toBeDisabled();
  });

  // A greyed-out Send with a hint about the label PDF — which is right there,
  // filled in — is worse than no hint at all.
  it('says it is the starter, not the label details', () => {
    render(<EzTransPanel row={row} order={order} starterGap={STARTER_GAP} />);
    fillLabel();

    expect(screen.getByText(/The compost starter comes first/i)).toBeInTheDocument();
    expect(screen.queryByText(/Carrier, tracking number and the label PDF are all required/i))
      .toBeNull();
  });

  it('opens both sends once the starter is answered', () => {
    render(<EzTransPanel row={row} order={order} starterGap={null} />);
    fillLabel();

    expect(confirmButton()).toBeEnabled();
    expect(sendButton()).toBeEnabled();
  });

  // The panel predates the gate and is rendered from one call site, but the
  // prop is optional — an absent answer must not shut the 3PL out.
  it('asks for nothing when no answer is handed down at all', () => {
    render(<EzTransPanel row={row} order={order} />);
    fillLabel();

    expect(confirmButton()).toBeEnabled();
  });
});

// EZ Trans hold the machine whoever booked the carrier. When the carton went
// out on a Freightcom booking — #1258, Canpar out of the Freightcom portal
// while the unit sat at the 3PL — the handoff email is owed exactly as it is
// on a Goorooship booking, and it has to queue into the same end-of-day batch.
// What must NOT come with it is a second copy of the label fields: that decoy
// is what left #1258's Canpar number in a card no button read.
describe('EzTransPanel — the handoff email for a carton booked on Freightcom', () => {
  const EXTERNAL = {
    carrier: 'Canpar',
    tracking_num: 'D556276790000169272001',
    labelOnFile: true,
  };

  beforeEach(() => {
    placementMock.mockReset().mockReturnValue(AT_EZTRANS);
    saveLabelMock.mockClear();
    sendMock.mockClear();
    localStorage.clear();
    logActionMock.mockClear();
    confirmMock.mockClear();
    markSentMock.mockClear();
  });

  it('asks for no label of its own, and names the one it was given', () => {
    render(<EzTransPanel row={row} order={order} externalLabel={EXTERNAL} />);

    expect(screen.queryByLabelText(/carrier/i)).toBeNull();
    expect(screen.queryByLabelText(/tracking number/i)).toBeNull();
    expect(screen.queryByLabelText(/shipping label pdf/i)).toBeNull();
    expect(screen.queryByRole('link', { name: /goorooship — book a shipment/i })).toBeNull();

    expect(screen.getByTestId('eztrans-external-label'))
      .toHaveTextContent(/Canpar D556276790000169272001, booked on Freightcom/);
  });

  // The whole point: it still queues, into the same batch, from the same button.
  it('queues into the day batch with the Freightcom label', async () => {
    render(<EzTransPanel row={row} order={order} externalLabel={EXTERNAL} />);

    const btn = confirmButton();
    expect(btn).toBeEnabled();
    fireEvent.click(btn);

    await waitFor(() => expect(confirmMock).toHaveBeenCalledWith('q-1', expect.objectContaining({
      carrier: 'Canpar', tracking_num: 'D556276790000169272001',
    })));
    // The Freightcom panel already wrote those columns; writing them again
    // from a form this panel is not showing could only overwrite them staler.
    expect(saveLabelMock).not.toHaveBeenCalled();
    expect(confirmMock.mock.calls[0][1].label_pdf).toBeUndefined();
  });

  it('sends the one-order email with the Freightcom label too', async () => {
    render(<EzTransPanel row={row} order={order} externalLabel={EXTERNAL} />);

    fireEvent.click(sendButton());

    await waitFor(() => expect(sendMock).toHaveBeenCalledWith('q-1', undefined));
    expect(saveLabelMock).not.toHaveBeenCalled();
    await waitFor(() => expect(logActionMock).toHaveBeenCalledWith(
      expect.any(String), '#1184',
      expect.stringContaining('Canpar label'),
      expect.anything(),
    ));
    expect(logActionMock.mock.calls[0][2]).toContain('D556276790000169272001');
  });

  // The email carries the label as an attachment, so queueing one before the
  // Freightcom booking is confirmed would mail the 3PL a box with no label.
  it('will not queue before the Freightcom booking has a label on file', () => {
    render(
      <EzTransPanel row={row} order={order} externalLabel={{ ...EXTERNAL, labelOnFile: false }} />,
    );

    expect(confirmButton()).toBeDisabled();
    expect(screen.getByTestId('eztrans-external-label'))
      .toHaveTextContent(/Confirm the Freightcom booking above before sending/);
  });

  // The email body and the packing list are the 3PL's instruction sheet — both
  // have to describe the carrier that is actually coming, not the one this
  // panel's own (hidden, empty) form holds.
  it('describes the Freightcom shipment in the documents it previews', () => {
    render(<EzTransPanel row={row} order={order} externalLabel={EXTERNAL} />);

    fireEvent.click(screen.getByRole('button', { name: /preview \/ edit email/i }));

    // The email names it one way, the packing list the other.
    expect(screen.getByText(/Tracking Number: D556276790000169272001/)).toBeInTheDocument();
    expect(screen.getByText(/Tracking No: D556276790000169272001/)).toBeInTheDocument();
  });
});
