import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { setStarterMock, sendEmailMock } = vi.hoisted(() => ({
  setStarterMock: vi.fn(() => Promise.resolve()),
  sendEmailMock: vi.fn(() => Promise.resolve({ email_id: 're_123' })),
}));

vi.mock('../../../lib/fulfillment', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/fulfillment')>('../../../lib/fulfillment');
  return {
    ...actual,
    setStarterTracking: setStarterMock,
    sendFulfillmentEmail: sendEmailMock,
  };
});

import { StepEmail } from '../queue/StepEmail';
import type { FulfillmentQueueRow } from '../../../lib/fulfillment';

const rowBase: FulfillmentQueueRow = {
  id: 'q-e', order_id: 'o-e', step: 5, assigned_serial: 'LL01-00000000050',
  test_report_url: null, test_confirmed_at: null, test_confirmed_by: null,
  carrier: 'UPS', tracking_num: '1ZABC',
  label_pdf_path: null, label_confirmed_at: null, label_confirmed_by: null,
  dock_printed: true, dock_affixed: true, dock_docked: true, dock_notified: true,
  dock_confirmed_at: null, dock_confirmed_by: null,
  starter_tracking_num: null, email_sent_at: null, email_sent_by: null,
  fulfilled_at: null, fulfilled_by: null, due_date: null, created_at: '2026-04-19T00:00:00Z',
};

const orderUS = { customer_name: 'Alice Ames', customer_email: 'a@ex.com', order_ref: '#1001', country: 'US' as const };
const orderCA = { customer_name: 'Bob Boxer',  customer_email: 'b@ex.com', order_ref: '#1002', country: 'CA' as const };

describe('StepEmail', () => {
  beforeEach(() => { setStarterMock.mockClear(); sendEmailMock.mockClear(); });

  it('US order: Send disabled until starter tracking is filled', () => {
    render(<StepEmail row={rowBase} order={orderUS} />);
    expect(screen.getByRole('button', { name: /send email/i })).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText(/1Z.+starter/i), { target: { value: '1ZSTARTER' } });
    expect(screen.getByRole('button', { name: /send email/i })).toBeEnabled();
  });

  it('CA order: no starter field shown; Send enabled right away', () => {
    render(<StepEmail row={rowBase} order={orderCA} />);
    expect(screen.queryByPlaceholderText(/starter/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /send email/i })).toBeEnabled();
  });

  it('Clicking Send calls sendFulfillmentEmail', async () => {
    render(<StepEmail row={rowBase} order={orderCA} />);
    fireEvent.click(screen.getByRole('button', { name: /send email/i }));
    await waitFor(() => expect(sendEmailMock).toHaveBeenCalledWith('q-e'));
  });
});
