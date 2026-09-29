// The button at the bottom of the Fulfillment queue.
//
// The thing worth protecting here is that the email carries exactly what the
// bar listed: the operator reads a count off the screen and presses a button
// that mails a 3PL. An order shown as waiting that does not go, or one that
// goes without being shown, is the failure that costs a day of cartons.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Declared with its real signature so `mockResolvedValueOnce` below is typed
// against the response shape rather than narrowed to the first literal — a
// cast in a test file is a tsc -b failure waiting to happen, and tsc -b is
// what gates the deploy.
type SendResult = {
  email_id: string;
  to: string;
  cc: string[];
  from?: string;
  sent_via?: 'gmail' | 'resend';
  warning?: string;
  orders: Array<{
    queue_id: string; order_id: string; order_ref: string; customer_name: string;
    serial: string | null; tracking: string; documents: string[];
  }>;
  skipped: Array<{ queue_id: string; order_ref?: string; reason: string }>;
  attachments: string[];
  unsigned_worksheets: string[];
};

const { sendMock, logActionMock } = vi.hoisted(() => ({
  sendMock: vi.fn((queueIds: string[]): Promise<SendResult> => {
    void queueIds;
    return Promise.resolve({
      email_id: 'g1',
      to: 'cs@goorooship.ca',
      cc: ['reina@virgohome.io'],
      from: 'VCycene Fulfillment <reina@virgohome.io>',
      sent_via: 'gmail' as const,
      orders: [{
        queue_id: 'q-a', order_id: 'o-a', order_ref: '#1184',
        customer_name: 'Juanita M Wells', serial: 'LL01-P100X-00412', tracking: 'U1',
        documents: ['label-and-packing-list-Juanita-M-Wells-U1.pdf'],
      }],
      skipped: [],
      attachments: ['label-and-packing-list-Juanita-M-Wells-U1.pdf'],
      unsigned_worksheets: [],
    });
  }),
  logActionMock: vi.fn((..._args: unknown[]) => Promise.resolve()),
}));

vi.mock('../../../lib/eztransBatch', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/eztransBatch')>('../../../lib/eztransBatch');
  return { ...actual, sendEzTransDailyBatch: sendMock };
});

vi.mock('../../../lib/activityLog', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/activityLog')>('../../../lib/activityLog');
  return { ...actual, logAction: logActionMock };
});

import { GoorooshipDailyBatch } from '../queue/GoorooshipDailyBatch';
import type { EzTransBatchOrder, EzTransBatchQueueRow } from '../../../lib/eztransBatch';

const ORDERS = new Map<string, EzTransBatchOrder>([
  ['o-a', { id: 'o-a', order_ref: '#1184', customer_name: 'Juanita M Wells' }],
  ['o-b', { id: 'o-b', order_ref: '#1185', customer_name: 'Marc Bérubé' }],
]);

/** Today, locally — the bar buckets by the operator's calendar day. */
const TODAY = new Date(new Date().setHours(14, 5, 0, 0)).toISOString();
const YESTERDAY = new Date(new Date(Date.now() - 86_400_000).setHours(14, 5, 0, 0)).toISOString();

function row(over: Partial<EzTransBatchQueueRow> & { id: string }): EzTransBatchQueueRow {
  return {
    order_id: 'o-a', assigned_serial: 'LL01-P100X-00412',
    carrier: 'UPS', tracking_num: 'U1',
    eztrans_confirmed_at: null, eztrans_batch_sent_at: null, eztrans_packing_list: null,
    ...over,
  };
}

const sendButton = () => screen.getByRole('button', { name: /email today's fulfilled orders to goorooship/i });

describe('GoorooshipDailyBatch', () => {
  beforeEach(() => { sendMock.mockClear(); logActionMock.mockClear(); });

  it('has nothing to send on a day nobody confirmed anything', () => {
    render(<GoorooshipDailyBatch rows={[]} orders={ORDERS} />);
    expect(sendButton()).toBeDisabled();
    expect(screen.getByText(/Nothing is confirmed for EZ Trans today/i)).toBeInTheDocument();
  });

  it('lists what is waiting and names the documents each order brings', () => {
    render(
      <GoorooshipDailyBatch
        rows={[row({ id: 'q-a', eztrans_confirmed_at: TODAY })]}
        orders={ORDERS}
      />,
    );
    expect(screen.getByText('Juanita M Wells')).toBeInTheDocument();
    expect(screen.getByText(/1 waiting/)).toBeInTheDocument();
    // UPS, so the worksheet rides along as its own file — both named for the
    // customer and the tracking number.
    expect(screen.getByText(
      'label-and-packing-list-Juanita-M-Wells-U1.pdf · pesticide-worksheet-Juanita-M-Wells-U1.pdf',
    )).toBeInTheDocument();
  });

  it('leaves out an order confirmed on another day', () => {
    render(
      <GoorooshipDailyBatch
        rows={[row({ id: 'q-b', order_id: 'o-b', eztrans_confirmed_at: YESTERDAY })]}
        orders={ORDERS}
      />,
    );
    expect(sendButton()).toBeDisabled();
    expect(screen.queryByText('Marc Bérubé')).not.toBeInTheDocument();
  });

  it('sends exactly the orders it listed as waiting', async () => {
    render(
      <GoorooshipDailyBatch
        rows={[
          row({ id: 'q-a', eztrans_confirmed_at: TODAY }),
          // Already gone: still listed, because "did this one go?" is the
          // question being asked, but not sent a second time.
          row({ id: 'q-b', order_id: 'o-b', tracking_num: 'P1', carrier: 'Purolator',
                eztrans_confirmed_at: TODAY, eztrans_batch_sent_at: TODAY }),
        ]}
        orders={ORDERS}
      />,
    );
    expect(screen.getByText(/1 waiting · 1 already sent today/)).toBeInTheDocument();
    fireEvent.click(sendButton());
    await waitFor(() => expect(sendMock).toHaveBeenCalledWith(['q-a']));
  });

  it('logs the send against each order that actually went', async () => {
    render(
      <GoorooshipDailyBatch rows={[row({ id: 'q-a', eztrans_confirmed_at: TODAY })]} orders={ORDERS} />,
    );
    fireEvent.click(sendButton());
    await waitFor(() => expect(logActionMock).toHaveBeenCalledTimes(1));
    expect(logActionMock.mock.calls[0][1]).toBe('#1184');
    expect(String(logActionMock.mock.calls[0][2])).toContain('label-and-packing-list-Juanita-M-Wells-U1.pdf');
    expect(logActionMock.mock.calls[0][3]).toMatchObject({ entityType: 'order', entityId: 'o-a' });
  });

  it('says which orders the server refused rather than letting them vanish', async () => {
    sendMock.mockResolvedValueOnce({
      email_id: 'g2', to: 'cs@goorooship.ca', cc: [], orders: [],
      skipped: [{ queue_id: 'q-a', order_ref: '#1184', reason: 'no shipping label attached' }],
      attachments: [], unsigned_worksheets: [],
    });
    render(
      <GoorooshipDailyBatch rows={[row({ id: 'q-a', eztrans_confirmed_at: TODAY })]} orders={ORDERS} />,
    );
    fireEvent.click(sendButton());
    expect(await screen.findByText(/#1184 \(no shipping label attached\)/)).toBeInTheDocument();
  });

  it('surfaces a failed send instead of looking like it worked', async () => {
    sendMock.mockRejectedValueOnce(new Error('Goorooship batch email failed (502): Resend refused'));
    render(
      <GoorooshipDailyBatch rows={[row({ id: 'q-a', eztrans_confirmed_at: TODAY })]} orders={ORDERS} />,
    );
    fireEvent.click(sendButton());
    expect(await screen.findByText(/Resend refused/)).toBeInTheDocument();
    expect(logActionMock).not.toHaveBeenCalled();
  });
});
