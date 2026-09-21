import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render as rtlRender, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';

type SaveLabelInput = { carrier: string; tracking_num: string; label_pdf?: File };

const { placementMock, saveLabelMock, sendMock, logActionMock } = vi.hoisted(() => ({
  placementMock: vi.fn(),
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
    useEzTransPlacement: placementMock,
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
  id: 'q-1', order_id: 'o-1', step: 3, assigned_serial: 'LL01-P100X-00412',
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
  placement: { serial: 'LL01-P100X-00412', skid: 'EZ-P01', pallet: 'P01', masterCarton: '1' },
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

const sendButton = () => screen.getByRole('button', { name: /send confirmation to cs@goorooship\.ca/i });

describe('EzTransPanel', () => {
  beforeEach(() => {
    placementMock.mockReset().mockReturnValue(AT_EZTRANS);
    saveLabelMock.mockClear();
    sendMock.mockClear();
    localStorage.clear();
    logActionMock.mockClear();
  });

  it('stays out of the way for a unit that is not at EZ Trans', () => {
    placementMock.mockReturnValue({ placement: null, loading: false });
    const { container } = render(<EzTransPanel row={row} order={order} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('offers the Goorooship booking link for a unit that is', () => {
    render(<EzTransPanel row={row} order={order} />);
    expect(screen.getByRole('link', { name: /goorooship — book a shipment/i }))
      .toHaveAttribute('href', 'https://app.goorooship.ca/ship');
  });

  it('will not send until carrier, tracking and the label are all present', () => {
    render(<EzTransPanel row={row} order={order} />);
    expect(sendButton()).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/carrier/i), { target: { value: 'Purolator' } });
    expect(sendButton()).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/tracking number/i), { target: { value: 'PUR123456789' } });
    expect(sendButton()).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/shipping label pdf/i), { target: { files: [labelFile()] } });
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
    expect(override?.body).toContain('Hello EZ Trans team');
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
  it('shows who is copied, so the recipient list is not a matter of faith', () => {
    render(<EzTransPanel row={row} order={order} />);
    const copied = screen.getByText(/reina@virgohome\.io/).textContent ?? '';
    expect(copied).toContain('huayi@virgohome.io');
    expect(copied).toContain('support@goorooship.ca');
  });
});
