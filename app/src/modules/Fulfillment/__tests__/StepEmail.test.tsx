import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { sendEmailMock, markOrderShippedMock } = vi.hoisted(() => ({
  sendEmailMock: vi.fn(() => Promise.resolve({ email_id: 're_123' })),
  markOrderShippedMock: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../../lib/fulfillment', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/fulfillment')>('../../../lib/fulfillment');
  return {
    ...actual,
    sendFulfillmentEmail: sendEmailMock,
  };
});

vi.mock('../../../lib/orders', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/orders')>('../../../lib/orders');
  return {
    ...actual,
    markOrderShipped: markOrderShippedMock,
  };
});

import { StepEmail } from '../queue/StepEmail';
import type { FulfillmentQueueRow } from '../../../lib/fulfillment';

const rowBase: FulfillmentQueueRow = {
  id: 'q-e', order_id: 'o-e', step: 5, assigned_serial: 'LL01-00000000050',
  test_report_url: null, test_confirmed_at: null, test_confirmed_by: null,
  carrier: 'UPS', tracking_num: '1ZABC',
  label_pdf_path: null, label_confirmed_at: null, label_confirmed_by: null,
  dock_printed: true, dock_affixed: true, dock_docked: true, dock_notified: true, dock_picked_up: true,
  dock_confirmed_at: null, dock_confirmed_by: null,
  starter_tracking_num: null, email_sent_at: '2026-04-19T12:00:00Z', email_sent_by: null,
  fulfilled_at: null, fulfilled_by: null, due_date: null, priority: false, created_at: '2026-04-19T00:00:00Z',
};

const orderUS       = { id: 'o-us', customer_name: 'Alice Ames', customer_email: 'a@ex.com', order_ref: '#1001', country: 'US' as const };
const orderCA       = { id: 'o-ca', customer_name: 'Bob Boxer',  customer_email: 'b@ex.com', order_ref: '#1002', country: 'CA' as const };
const orderNoEmail  = { id: 'o-ne', customer_name: 'Cory C',     customer_email: null,       order_ref: '#1003', country: 'CA' as const };

describe('StepEmail', () => {
  beforeEach(() => { sendEmailMock.mockClear(); markOrderShippedMock.mockClear(); });

  it('Send disabled until shipping cost is entered', () => {
    render(<StepEmail row={rowBase} order={orderUS} />);
    expect(screen.getByRole('button', { name: /send email/i })).toBeDisabled();
  });

  it('Send enabled after shipping cost is entered (US order)', () => {
    render(<StepEmail row={rowBase} order={orderUS} />);
    fireEvent.change(screen.getByPlaceholderText('42.75'), { target: { value: '35.00' } });
    expect(screen.getByRole('button', { name: /send email/i })).toBeEnabled();
  });

  it('Send enabled after shipping cost is entered (CA order)', () => {
    render(<StepEmail row={rowBase} order={orderCA} />);
    fireEvent.change(screen.getByPlaceholderText('42.75'), { target: { value: '35.00' } });
    expect(screen.getByRole('button', { name: /send email/i })).toBeEnabled();
  });

  it('Send disabled when customer_email is missing', () => {
    render(<StepEmail row={rowBase} order={orderNoEmail} />);
    fireEvent.change(screen.getByPlaceholderText('42.75'), { target: { value: '35.00' } });
    expect(screen.getByRole('button', { name: /send email/i })).toBeDisabled();
  });

  it('Preview includes tracking link and Calendly onboarding URL', () => {
    render(<StepEmail row={rowBase} order={orderCA} />);
    expect(screen.getByText(/Your LILA has officially shipped/)).toBeInTheDocument();
    expect(screen.getByText(/calendly\.com\/lila-ed/)).toBeInTheDocument();
  });

  it('Clicking Send calls markOrderShipped then sendFulfillmentEmail', async () => {
    render(<StepEmail row={rowBase} order={orderCA} />);
    fireEvent.change(screen.getByPlaceholderText('42.75'), { target: { value: '42.75' } });
    fireEvent.click(screen.getByRole('button', { name: /send email/i }));
    await waitFor(() => expect(markOrderShippedMock).toHaveBeenCalledWith('o-ca', 42.75));
    await waitFor(() => expect(sendEmailMock).toHaveBeenCalledWith('q-e'));
  });

  it('Does NOT auto-send (auto-send disabled; shipping cost required first)', async () => {
    const freshRow = { ...rowBase, email_sent_at: null, email_sent_by: null };
    render(<StepEmail row={freshRow} order={orderCA} />);
    // Wait a tick to confirm no auto-send fires
    await new Promise(r => setTimeout(r, 50));
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('Does NOT auto-send when email_sent_at is already populated', () => {
    render(<StepEmail row={rowBase} order={orderCA} />);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('Does NOT auto-send when customer_email is missing', () => {
    const freshRow = { ...rowBase, email_sent_at: null };
    render(<StepEmail row={freshRow} order={orderNoEmail} />);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('Does NOT auto-send when tracking_num is missing', () => {
    const noTracking = { ...rowBase, email_sent_at: null, tracking_num: null };
    render(<StepEmail row={noTracking} order={orderCA} />);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });
});
