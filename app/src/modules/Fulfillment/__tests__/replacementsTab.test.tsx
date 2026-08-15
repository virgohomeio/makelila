import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { ServiceTicket } from '../../../lib/service';

// The Replacement queue moved from Service to Fulfillment. It is still
// TICKET-DRIVEN: the only way to create a replacement order is to open a
// support ticket and click "Send replacement". This suite walks that path
// from its new home — Fulfillment > Replacements > triage row > ticket panel
// > picker > createReplacementOrder — with only the data layer stubbed.

const createReplacementOrderMock = vi.fn().mockResolvedValue({ id: 'o9', order_ref: 'R-0009' });

const TRIAGE_TICKET = {
  id: 't1',
  ticket_number: 'TKT-501',
  category: 'support',
  source: 'gmail',
  status: 'waiting_on_us',
  priority: 'normal',
  tags: [],
  customer_id: null, customer_name: 'Linda', customer_email: 'linda@example.com',
  customer_phone: null, unit_serial: null, order_ref: null,
  subject: 'Lid hinge snapped', description: null, internal_notes: null,
  defect_category: null, parts_needed: null,
  calendly_event_uri: null, calendly_event_start: null, calendly_host_email: null,
  hubspot_ticket_id: null, fulfillment_queue_id: null,
  owner_email: null, resolved_at: null, closed_at: null,
  // No replacement order yet — this is what makes it a triage candidate.
  replacement_order_id: null,
  diagnosis_link_sent_at: null, diag_cohost_invited_at: null,
  google_calendar_event_id: null,
  created_at: '2026-06-01T00:00:00Z', updated_at: '2026-06-01T00:00:00Z',
  gmail_thread_id: null, gmail_account: null,
  topic: 'warranty_replacement', summary: null, suggested_next_action: null,
  last_classified_at: null, classification_confidence: null,
  message_count: 1,
  first_message_at: '2026-06-01T00:00:00Z',
  last_message_at: '2026-06-01T00:00:00Z',
  is_manually_overridden: false,
  issue_area: null,
  kind: 'ticket',
  inbox_disposition: null,
  sla_policy_id: null,
  first_response_due_at: null,
  resolution_due_at: null,
  first_responded_at: null,
  sla_resolved_at: null,
  sla_status: null,
  root_cause: null,
  linear_issue_url: null,
  github_issue_url: null,
  engineering_resolved_at: null,
} as unknown as ServiceTicket;

vi.mock('../../../lib/orders', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/orders')>('../../../lib/orders');
  return {
    ...actual,
    createReplacementOrder: (...args: unknown[]) => createReplacementOrderMock(...(args as [])),
    useReplacementSummary: () => ({ summary: null, loading: false }),
    useReplacementOrders: () => ({
      orders: [
        { id: 'o1', order_ref: 'R-0001', kind: 'replacement', status: 'pending',
          customer_name: 'Sam', cogs_usd: 12.5, shipped_at: null, delivered_at: null,
          created_at: '2026-06-02T00:00:00Z', linked_ticket_id: 't2',
          line_items: [{ kind: 'part', part_id: 'p1', sku: 'HINGE', name: 'Lid Hinge', qty: 1, cost_per_unit_usd: 4.2 }] },
      ],
      loading: false,
    }),
  };
});
vi.mock('../../../lib/service', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/service')>('../../../lib/service');
  return {
    ...actual,
    useServiceTickets: () => ({ tickets: [TRIAGE_TICKET], loading: false }),
    useCustomerLifecycle: () => ({ row: null, loading: false }),
    useTicketMessages: () => ({ messages: [], loading: false }),
    useClassificationLog: () => ({ entries: [], loading: false }),
  };
});
vi.mock('../../../lib/stock', () => ({
  useUnits: () => ({ units: [{ serial: 'LL01-284', batch: 'B7', status: 'ready', color: 'White' }], loading: false }),
  useBatches: () => ({
    batches: [{ id: 'B7', unit_cost_usd: 312, arrived_at: '2026-01-01', version: null, manufacturer: 'X' }],
    loading: false,
  }),
}));
vi.mock('../../../lib/parts', () => ({
  useParts: () => ({
    parts: [{ id: 'p1', sku: 'HINGE', name: 'Lid Hinge', category: 'replacement', on_hand: 5, cost_per_unit_usd: 4.2 }],
    loading: false,
  }),
}));
vi.mock('../../../lib/customers', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/customers')>('../../../lib/customers');
  return { ...actual, useCustomers: () => ({ customers: [] }) };
});
vi.mock('../../../lib/auth', () => ({ useAuth: () => ({ user: { email: 'huayi@virgohome.io' } }) }));
vi.mock('../../../lib/useMediaQuery', () => ({ useIsMobile: () => false }));
// Child panels of the ticket detail each open their own Supabase channels.
vi.mock('../../Service/TicketNotes', () => ({ TicketNotes: () => null }));
vi.mock('../../Service/TicketActionItems', () => ({ TicketActionItems: () => null }));
vi.mock('../../Service/AttachmentStrip', () => ({ AttachmentStrip: () => null }));
vi.mock('../../../components/DeviceContextHeader', () => ({ DeviceContextHeader: () => null }));

import Fulfillment from '../index';

const renderTab = () =>
  render(
    <MemoryRouter initialEntries={['/fulfillment/replacements']}>
      <Routes>
        <Route path="/fulfillment/:tab" element={<Fulfillment />} />
        <Route path="/order-review/:orderId" element={<div>ORDER_REVIEW</div>} />
      </Routes>
    </MemoryRouter>,
  );

describe('Fulfillment > Replacements — still ticket-driven', () => {
  beforeEach(() => createReplacementOrderMock.mockClear());

  it('renders the replacement queue, not the old PostShipment tab', () => {
    renderTab();
    expect(screen.getByText('Queued replacement demand')).toBeInTheDocument();
    expect(screen.getByText('Replacement orders')).toBeInTheDocument();
    expect(screen.getByText('R-0001')).toBeInTheDocument();
  });

  it('surfaces warranty/defect tickets without a replacement order as triage candidates', () => {
    renderTab();
    expect(screen.getByText('Triage candidates from tickets')).toBeInTheDocument();
    expect(screen.getByText('TKT-501')).toBeInTheDocument();
  });

  it('opens the ticket panel from a triage row and offers "Send replacement"', () => {
    renderTab();
    fireEvent.click(screen.getByText('TKT-501'));
    // The subject renders twice once the panel is open — in the triage row and
    // as the panel heading; the heading is the panel.
    expect(screen.getByRole('heading', { name: /Lid hinge snapped/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /send replacement/i })).toBeInTheDocument();
  });

  it('creates the replacement order through the picker, from the ticket', async () => {
    renderTab();
    fireEvent.click(screen.getByText('TKT-501'));
    fireEvent.click(screen.getByRole('button', { name: /send replacement/i }));

    // Picker is open and stocked from parts/units.
    fireEvent.click(await screen.findByText('Lid Hinge'));
    fireEvent.click(screen.getByRole('button', { name: /create replacement order/i }));

    await waitFor(() => expect(createReplacementOrderMock).toHaveBeenCalledTimes(1));
    // The order carries the originating ticket — that link is what puts it in
    // the queue and lets the ticket close when it is delivered.
    expect(createReplacementOrderMock.mock.calls[0][0]).toMatchObject({
      ticket_id: 't1',
      customer_name: 'Linda',
      line_items: [expect.objectContaining({ kind: 'part', sku: 'HINGE' })],
    });
  });
});
