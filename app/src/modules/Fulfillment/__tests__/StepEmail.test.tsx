import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { sendEmailMock, markOrderShippedMock, updateTemplateMock, createTemplateMock, refreshMock, tplState } = vi.hoisted(() => ({
  sendEmailMock: vi.fn(() => Promise.resolve({ email_id: 're_123' })),
  markOrderShippedMock: vi.fn(() => Promise.resolve()),
  updateTemplateMock: vi.fn(() => Promise.resolve()),
  createTemplateMock: vi.fn(() => Promise.resolve()),
  refreshMock: vi.fn(() => Promise.resolve()),
  // Swapped per test: null (never seeded), the stale May row, or a good row.
  tplState: { current: null as null | Record<string, unknown> },
}));

/** The row actually live in production on 2026-09-23: it declares
 *  {{calendly_url}}, which the Step-5 renderer does not supply. */
const staleRow = {
  id: 'tpl-1', key: 'shipment_confirmation', name: 'LILA has shipped',
  category: 'fulfillment' as const, description: null,
  subject: 'Your LILA has officially shipped! 🎉 ({{order_ref}})',
  body: 'Hi {{customer_first_name}},\n\nBook a session here: {{calendly_url}}.',
  variables: ['calendly_url'], channel: 'email' as const, active: true,
  created_at: '2026-05-13T00:00:00Z', updated_at: '2026-05-13T00:00:00Z',
};

const goodRow = {
  ...staleRow,
  body: 'Hi {{customer_first_name}},\n\nTracking Link: {{tracking_url}}\n{{starter_block}}\nOperator wording.',
  variables: ['customer_first_name', 'tracking_url', 'starter_block'],
  updated_at: '2026-09-24T00:00:00Z',
};

vi.mock('../../../lib/templates', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/templates')>('../../../lib/templates');
  return {
    ...actual,
    useEmailTemplate: () => ({ template: tplState.current, loading: false, refresh: refreshMock }),
    updateTemplate: updateTemplateMock,
    createTemplate: createTemplateMock,
  };
});

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
  beforeEach(() => {
    sendEmailMock.mockClear(); markOrderShippedMock.mockClear();
    updateTemplateMock.mockClear(); createTemplateMock.mockClear(); refreshMock.mockClear();
    // Default: the stale row that shipped to production — the built-in
    // wording must win over it.
    tplState.current = { ...staleRow };
  });

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

  it('Preview renders the template with BOTH the weekday and off-hours Calendly links', () => {
    render(<StepEmail row={rowBase} order={orderCA} />);
    const body = screen.getByRole('textbox', { name: /Body/ }) as HTMLTextAreaElement;
    expect(body.value).toContain('https://calendly.com/lila-ed/intro-call');
    expect(body.value).toContain('https://calendly.com/lila-ed/lila-onboarding-with-danica-patrik');
    // The old bare-profile link is gone.
    expect(body.value).not.toContain('https://calendly.com/lila-ed.');
    // Variables are resolved, not left as placeholders.
    expect(body.value).toContain('Hi Bob,');
    expect(body.value).toContain('Tracking Number: 1ZABC');
  });

  it('Subject renders from the template', () => {
    render(<StepEmail row={rowBase} order={orderCA} />);
    expect((screen.getByRole('textbox', { name: /Subject/ }) as HTMLInputElement).value)
      .toBe('Your LILA has officially shipped! 🎉 (#1002)');
  });

  it('Empty starter block is stripped, not printed as {{starter_block}} (CA order)', () => {
    render(<StepEmail row={rowBase} order={orderCA} />);
    const body = (screen.getByRole('textbox', { name: /Body/ }) as HTMLTextAreaElement).value;
    expect(body).not.toContain('{{starter_block}}');
    expect(body).not.toContain('Compost Starter Kit');
  });

  it('Starter block renders for a US order with a starter tracking number', () => {
    const usRow = { ...rowBase, starter_tracking_num: 'TBA999' };
    render(<StepEmail row={usRow} order={orderUS} />);
    const body = (screen.getByRole('textbox', { name: /Body/ }) as HTMLTextAreaElement).value;
    expect(body).toContain('Compost Starter Kit (ships separately via Amazon)');
    expect(body).toContain('Starter Tracking Number: TBA999');
  });

  it('An unedited send passes no overrides', async () => {
    render(<StepEmail row={rowBase} order={orderCA} />);
    fireEvent.change(screen.getByPlaceholderText('42.75'), { target: { value: '42.75' } });
    fireEvent.click(screen.getByRole('button', { name: /send email/i }));
    await waitFor(() => expect(sendEmailMock).toHaveBeenCalled());
    const [, content] = sendEmailMock.mock.calls[0] as unknown as [string, { subject: string; body: string; edited: boolean }];
    expect(content.edited).toBe(false);
    expect(content.body).toContain('https://calendly.com/lila-ed/intro-call');
  });

  it('An edited body is what gets sent', async () => {
    render(<StepEmail row={rowBase} order={orderCA} />);
    fireEvent.change(screen.getByRole('textbox', { name: /Body/ }), { target: { value: 'Hand-written note.' } });
    fireEvent.change(screen.getByPlaceholderText('42.75'), { target: { value: '42.75' } });
    fireEvent.click(screen.getByRole('button', { name: /send email/i }));
    await waitFor(() => expect(sendEmailMock).toHaveBeenCalledWith('q-e', {
      subject: 'Your LILA has officially shipped! 🎉 (#1002)',
      body: 'Hand-written note.',
      edited: true,
    }));
  });

  // The regression this whole fallback exists for: the row live in production
  // declares {{calendly_url}}, so rendering it put a literal placeholder in
  // the draft and neither booking link appeared.
  it('A stale stored row is ignored — both links show, no raw placeholder', () => {
    tplState.current = { ...staleRow };
    render(<StepEmail row={rowBase} order={orderCA} />);
    const body = (screen.getByRole('textbox', { name: /Body/ }) as HTMLTextAreaElement).value;
    expect(body).toContain('https://calendly.com/lila-ed/intro-call');
    expect(body).toContain('https://calendly.com/lila-ed/lila-onboarding-with-danica-patrik');
    expect(body).not.toContain('{{calendly_url}}');
    expect(body).not.toContain('{{');
    expect(screen.getByText(/Showing the built-in wording/)).toBeInTheDocument();
  });

  it('Both links show when no template row exists at all', () => {
    tplState.current = null;
    render(<StepEmail row={rowBase} order={orderCA} />);
    const body = (screen.getByRole('textbox', { name: /Body/ }) as HTMLTextAreaElement).value;
    expect(body).toContain('https://calendly.com/lila-ed/intro-call');
    expect(body).toContain('https://calendly.com/lila-ed/lila-onboarding-with-danica-patrik');
    expect(screen.getByRole('button', { name: /send email/i })).toBeInTheDocument();
  });

  it('A renderable stored row overrides the built-in wording', () => {
    tplState.current = { ...goodRow };
    render(<StepEmail row={rowBase} order={orderCA} />);
    const body = (screen.getByRole('textbox', { name: /Body/ }) as HTMLTextAreaElement).value;
    expect(body).toContain('Operator wording.');
    expect(body).not.toContain('https://calendly.com/lila-ed/intro-call');
    expect(screen.queryByText(/Showing the built-in wording/)).not.toBeInTheDocument();
  });

  it('Saving over a stale row replaces its declared variables', async () => {
    tplState.current = { ...staleRow };
    render(<StepEmail row={rowBase} order={orderCA} />);
    const bodyBox = screen.getByRole('textbox', { name: /Body/ }) as HTMLTextAreaElement;
    fireEvent.change(bodyBox, { target: { value: `${bodyBox.value}\n\nPS.` } });
    fireEvent.click(screen.getByRole('button', { name: /save as default/i }));
    fireEvent.click(screen.getByRole('button', { name: /overwrite it for everyone/i }));
    await waitFor(() => expect(updateTemplateMock).toHaveBeenCalledTimes(1));
    const [, patch] = updateTemplateMock.mock.calls[0] as unknown as [string, { body: string; variables: string[] }];
    expect(patch.variables).toContain('starter_block');
    expect(patch.variables).not.toContain('calendly_url');
    expect(patch.body).not.toContain('{{calendly_url}}');
  });

  it('Saving with no row at all creates one', async () => {
    tplState.current = null;
    render(<StepEmail row={rowBase} order={orderCA} />);
    const bodyBox = screen.getByRole('textbox', { name: /Body/ }) as HTMLTextAreaElement;
    fireEvent.change(bodyBox, { target: { value: `${bodyBox.value}\n\nPS.` } });
    fireEvent.click(screen.getByRole('button', { name: /save as default/i }));
    fireEvent.click(screen.getByRole('button', { name: /overwrite it for everyone/i }));
    await waitFor(() => expect(createTemplateMock).toHaveBeenCalledTimes(1));
    expect(updateTemplateMock).not.toHaveBeenCalled();
  });

  it('Save as default needs a second click, then writes back with placeholders restored', async () => {
    render(<StepEmail row={rowBase} order={orderCA} />);
    const body = screen.getByRole('textbox', { name: /Body/ }) as HTMLTextAreaElement;
    fireEvent.change(body, { target: { value: `${body.value}\n\nPS. Compost away.` } });

    // First click only arms the confirm — the shared template is untouched.
    fireEvent.click(screen.getByRole('button', { name: /save as default/i }));
    expect(updateTemplateMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /overwrite it for everyone/i }));
    await waitFor(() => expect(updateTemplateMock).toHaveBeenCalledTimes(1));

    const [id, patch] = updateTemplateMock.mock.calls[0] as unknown as [string, { subject: string; body: string }];
    expect(id).toBe('tpl-1');
    expect(patch.body).toContain('PS. Compost away.');
    // This order's values must not be baked into the shared default.
    expect(patch.body).toContain('Hi {{customer_first_name}},');
    expect(patch.body).toContain('Tracking Number: {{tracking_num}}');
    expect(patch.body).not.toContain('Bob');
    expect(patch.body).not.toContain('1ZABC');
    // The template is re-read so the fields don't snap back to the old copy.
    await waitFor(() => expect(refreshMock).toHaveBeenCalled());
  });

  it('Reset drops the edit and the Save/Reset buttons', () => {
    render(<StepEmail row={rowBase} order={orderCA} />);
    const body = screen.getByRole('textbox', { name: /Body/ }) as HTMLTextAreaElement;
    const original = body.value;
    fireEvent.change(body, { target: { value: 'scratch' } });
    expect(screen.getByRole('button', { name: /save as default/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^reset$/i }));
    expect((screen.getByRole('textbox', { name: /Body/ }) as HTMLTextAreaElement).value).toBe(original);
    expect(screen.queryByRole('button', { name: /save as default/i })).not.toBeInTheDocument();
  });

  it('Clicking Send calls markOrderShipped then sendFulfillmentEmail', async () => {
    render(<StepEmail row={rowBase} order={orderCA} />);
    fireEvent.change(screen.getByPlaceholderText('42.75'), { target: { value: '42.75' } });
    fireEvent.click(screen.getByRole('button', { name: /send email/i }));
    // Currency is passed explicitly — the storage column is named `_usd` but
    // holds CAD, so the caller states it rather than letting anything infer.
    await waitFor(() => expect(markOrderShippedMock).toHaveBeenCalledWith('o-ca', 42.75, 'CAD'));
    await waitFor(() => expect(sendEmailMock).toHaveBeenCalled());
    const [, content] = sendEmailMock.mock.calls[0] as unknown as [string, { subject: string; body: string; edited: boolean }];
    expect(content.edited).toBe(false);
    expect(content.body).toContain('https://calendly.com/lila-ed/intro-call');
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
