import { describe, it, expect, vi } from 'vitest';
import { render as rtlRender, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';
import { SupportTab } from '../SupportTab';

// SupportTab uses useNavigate (deep-link to replacement orders), so every
// render needs a Router context.
const render = (ui: ReactElement) => rtlRender(<MemoryRouter>{ui}</MemoryRouter>);
import type { ServiceTicket } from '../../../lib/service';

function mkTicket(partial: Partial<ServiceTicket> & { id: string }): ServiceTicket {
  return {
    ticket_number: 'TKT-1',
    category: 'support',
    source: 'gmail',
    status: 'waiting_on_us',
    priority: 'normal',
    customer_id: null, customer_name: 'Alice', customer_email: 'a@x.com',
    customer_phone: null, unit_serial: null, order_ref: null,
    subject: 'help me', description: null, internal_notes: null,
    defect_category: null, parts_needed: null,
    calendly_event_uri: null, calendly_event_start: null, calendly_host_email: null,
    hubspot_ticket_id: null, fulfillment_queue_id: null,
    owner_email: null, resolved_at: null, closed_at: null,
    replacement_order_id: null,
    diagnosis_link_sent_at: null, diag_cohost_invited_at: null,
    google_calendar_event_id: null,
    created_at: '2026-06-01T00:00:00Z', updated_at: '2026-06-01T00:00:00Z',
    gmail_thread_id: null, gmail_account: null,
    topic: null, summary: null, suggested_next_action: null,
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
    ...partial,
  };
}

let ticketsToReturn: ServiceTicket[] = [];
vi.mock('../../../lib/service', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/service')>('../../../lib/service');
  return {
    ...actual,
    useServiceTickets: vi.fn(() => ({ tickets: ticketsToReturn, loading: false })),
    useTicketsClosedSince: vi.fn(() => ({ closedIds: new Set<string>(), loading: false })),
  };
});
vi.mock('../../../lib/customers', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/customers')>('../../../lib/customers');
  return { ...actual, useCustomers: vi.fn(() => ({ customers: [] })) };
});
vi.mock('../../../lib/stock', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/stock')>('../../../lib/stock');
  return { ...actual, useUnits: vi.fn(() => ({ units: [] })) };
});
// SupportTab (and the detail panel it opens) now reads the current operator
// via useAuth for the ticket-owner assignment flow. These bare renders have no
// AuthProvider, so stub the hook the same way the data hooks are stubbed.
vi.mock('../../../lib/auth', () => ({
  useAuth: vi.fn(() => ({ user: { email: 'huayi@virgohome.io' } })),
}));

describe('SupportTab status resilience', () => {
  it('renders cleanly with a canonical status', () => {
    ticketsToReturn = [mkTicket({ id: 't1' })];
    render(<SupportTab />);
    // The subject now appears in both the owner board card and the table row.
    expect(screen.getAllByText('help me').length).toBeGreaterThan(0);
  });

  it('does not crash when a ticket has an unexpected status value', () => {
    // Simulates a row delivered by realtime / a sync edge function whose
    // status is not in the frontend's known 7-state set.
    ticketsToReturn = [mkTicket({ id: 't2', status: 'triaging' as never })];
    expect(() => render(<SupportTab />)).not.toThrow();
    // The unknown status degrades to a humanized label rather than a blank cell.
    expect(screen.getByText('Triaging')).toBeInTheDocument();
  });

  it('does not crash opening the detail panel for an unexpected status', () => {
    ticketsToReturn = [mkTicket({ id: 't3', status: 'escalated' as never })];
    render(<SupportTab />);
    // Either the board card or the row opens the panel; click the first match.
    expect(() => fireEvent.click(screen.getAllByText('help me')[0])).not.toThrow();
  });

  it('shows the close date in the row for a closed ticket', () => {
    const closedAt = '2026-06-03T15:00:00Z';
    ticketsToReturn = [mkTicket({ id: 't4', status: 'closed', closed_at: closedAt })];
    render(<SupportTab />);
    expect(screen.getByText(`Closed ${new Date(closedAt).toLocaleDateString()}`)).toBeInTheDocument();
  });

  it('shows each ticket\'s created date in its row', () => {
    const createdAt = '2026-05-20T12:00:00Z';
    ticketsToReturn = [mkTicket({ id: 'cr1', created_at: createdAt })];
    render(<SupportTab />);
    expect(screen.getByText(new Date(createdAt).toLocaleDateString())).toBeInTheDocument();
  });

  it('does not show a close date for a non-closed ticket', () => {
    ticketsToReturn = [mkTicket({ id: 't5', status: 'in_progress', closed_at: null })];
    render(<SupportTab />);
    // /^Closed \d/ targets the row "Closed <date>" without matching the
    // "Closed (7d)" KPI card label.
    expect(screen.queryByText(/^Closed \d/)).not.toBeInTheDocument();
  });

  it('Open KPI counts every ticket that is not closed', () => {
    ticketsToReturn = [
      mkTicket({ id: 'o1', status: 'in_progress' }),
      mkTicket({ id: 'o2', status: 'waiting_on_us' }),
      mkTicket({ id: 'o3', status: 'waiting_on_customer' }),
      mkTicket({ id: 'c1', status: 'closed', closed_at: '2026-06-03T00:00:00Z' }),
    ];
    render(<SupportTab />);
    // Kpi renders <div.kpiCard><div>label</div><div>value</div></div>, so the
    // label's parent is the card holding both label and value.
    const openCard = screen.getByText('Open').parentElement;
    expect(openCard).toHaveTextContent('3');
  });
});
