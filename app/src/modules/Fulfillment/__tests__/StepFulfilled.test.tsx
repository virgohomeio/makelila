import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { sentState } = vi.hoisted(() => ({
  sentState: { current: null as null | Record<string, unknown>, loading: false },
}));

vi.mock('../../../lib/templates', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/templates')>('../../../lib/templates');
  return {
    ...actual,
    useSentEmail: () => ({ message: sentState.current, loading: sentState.loading }),
  };
});

import { StepFulfilled } from '../queue/StepFulfilled';
import type { FulfillmentQueueRow } from '../../../lib/fulfillment';

const row: FulfillmentQueueRow = {
  id: '7804f78b-6756-40ac-a105-54e65bf5ce4b', order_id: 'o-1', step: 6,
  assigned_serial: 'LL01-00000000351',
  test_report_url: null, test_confirmed_at: null, test_confirmed_by: null,
  carrier: 'Purolator', tracking_num: '520763643704',
  label_pdf_path: null, label_confirmed_at: null, label_confirmed_by: null,
  dock_printed: true, dock_affixed: true, dock_docked: true, dock_notified: true, dock_picked_up: true,
  dock_confirmed_at: null, dock_confirmed_by: null,
  starter_tracking_num: null,
  email_sent_at: '2026-09-24T15:47:54.133Z', email_sent_by: 'u-1',
  fulfilled_at: '2026-09-24T15:47:54.133Z', fulfilled_by: 'u-1',
  due_date: null, priority: false, created_at: '2026-09-01T00:00:00Z',
};

const order = {
  customer_name: 'Juanita M Wells', customer_email: 'juanitawells7@hotmail.com',
  order_ref: '#1184', country: 'CA' as const,
};

const message = {
  id: 'm-1', template_key: 'shipment_confirmation',
  recipient_email: 'juanitawells7@hotmail.com', recipient_name: 'Juanita M Wells',
  subject: 'Your LILA has officially shipped! 🎉 (#1184)',
  body: 'Hi Juanita,\n\nBook a weekday session (business hours):\nhttps://calendly.com/lila-ed/intro-call',
  variables: { order_ref: '#1184' }, status: 'sent' as const,
  resend_id: '01a0d41a-13b4-7983-b051-33f0c129a06b', error: null,
  related_return_id: null, related_refund_id: null, related_cancellation_id: null,
  sent_by: 'u-1', sent_at: '2026-09-24T15:47:53.98Z', created_at: '2026-09-24T15:47:53.777Z',
};

describe('StepFulfilled — proof the shipment email went out', () => {
  beforeEach(() => { sentState.current = { ...message }; sentState.loading = false; });

  it('Names where the mail actually went, and the Resend id', () => {
    render(<StepFulfilled row={row} order={order} />);
    // "Delivered to" is deliberately separate from the order's address on
    // file — under EMAIL_TEST_RECIPIENT the two differ, and the one that
    // matters is where Resend actually sent it.
    const deliveredTo = screen.getByText('Delivered to').nextElementSibling;
    expect(deliveredTo).toHaveTextContent('juanitawells7@hotmail.com');
    expect(screen.getByText('01a0d41a-13b4-7983-b051-33f0c129a06b')).toBeInTheDocument();
  });

  it('Shows the exact body that was sent, on request', () => {
    render(<StepFulfilled row={row} order={order} />);
    expect(screen.queryByText(/calendly\.com\/lila-ed\/intro-call/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /read the email that was sent/i }));
    expect(screen.getByText(/calendly\.com\/lila-ed\/intro-call/)).toBeInTheDocument();
  });

  it('Explains that Resend leaves nothing in the Sent folder', () => {
    render(<StepFulfilled row={row} order={order} />);
    expect(screen.getByText(/will not appear in the support@lilacomposter\.com Sent folder/))
      .toBeInTheDocument();
  });

  // Only sends from 2026-09-24 onward were logged. An older order must not
  // read as though the email never went out.
  it('Says the copy was not kept, rather than implying no email was sent', async () => {
    sentState.current = null;
    render(<StepFulfilled row={row} order={order} />);
    await waitFor(() => expect(screen.getByText(/no copy\s+was kept/)).toBeInTheDocument());
    expect(screen.getByText(/recorded this as sent/)).toBeInTheDocument();
  });

  it('Shows nothing at all when the queue never recorded a send', () => {
    const unsent = { ...row, email_sent_at: null };
    render(<StepFulfilled row={unsent} order={order} />);
    expect(screen.queryByText(/Shipment email/)).not.toBeInTheDocument();
  });

  it('Surfaces a failed send instead of hiding it', () => {
    sentState.current = { ...message, status: 'failed', error: 'Resend 502: upstream' };
    render(<StepFulfilled row={row} order={order} />);
    expect(screen.getByText(/Resend 502: upstream/)).toBeInTheDocument();
  });
});
