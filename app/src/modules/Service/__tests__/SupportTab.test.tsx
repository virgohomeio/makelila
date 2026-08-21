import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render as rtlRender, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';
import { SupportTab } from '../SupportTab';

// SupportTab uses useNavigate (deep-link to replacement orders), so every
// render needs a Router context.
const render = (ui: ReactElement) => rtlRender(<MemoryRouter>{ui}</MemoryRouter>);
import { STATUS_META, TICKET_STATUSES } from '../../../lib/service';
import type { ServiceTicket } from '../../../lib/service';
import type { Order } from '../../../lib/orders';

const mkReplacementOrder = (id: string, line_items: unknown[], extra: Partial<Order> = {}) =>
  ({ id, kind: 'replacement', line_items, awaiting_batch_id: null, linked_ticket_id: null, ...extra }) as Order;

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
let replacementOrdersToReturn: Order[] = [];
vi.mock('../../../lib/orders', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/orders')>('../../../lib/orders');
  return { ...actual, useReplacementOrders: vi.fn(() => ({ orders: replacementOrdersToReturn, loading: false })) };
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

  // Intake and throughput share one 7-day window so the pair reads as
  // "N in, M out" over the same period.
  it('counts intake over the past seven days, not just today', () => {
    const now = Date.now();
    const daysAgo = (n: number) => new Date(now - n * 86_400_000).toISOString();
    ticketsToReturn = [
      mkTicket({ id: 'a', status: 'waiting_on_us', created_at: daysAgo(0) }),
      mkTicket({ id: 'b', status: 'waiting_on_us', created_at: daysAgo(3) }),
      mkTicket({ id: 'c', status: 'waiting_on_us', created_at: daysAgo(6) }),
      // Outside the window.
      mkTicket({ id: 'd', status: 'waiting_on_us', created_at: daysAgo(9) }),
    ];
    render(<SupportTab />);
    expect(screen.getByText(/new this week/)).toHaveTextContent('3 new this week');
  });

  it('the header open count covers every ticket that is not closed', () => {
    ticketsToReturn = [
      mkTicket({ id: 'o1', status: 'in_progress' }),
      mkTicket({ id: 'o2', status: 'waiting_on_us' }),
      mkTicket({ id: 'o3', status: 'waiting_on_customer' }),
      mkTicket({ id: 'c1', status: 'closed', closed_at: '2026-06-03T00:00:00Z' }),
    ];
    render(<SupportTab />);
    // The five KPI tiles collapsed into one sentence plus the queue bar; the
    // open figure now lives in the sentence.
    expect(screen.getByText(/open across/)).toHaveTextContent('3 open across');
  });

  // Every status stays filterable, including ones nothing currently holds — a
  // status an operator can set has to be a status they can find.
  it('offers all nine statuses as filters, even at zero', () => {
    ticketsToReturn = [mkTicket({ id: 'o1', status: 'waiting_on_us' })];
    render(<SupportTab />);
    for (const s of TICKET_STATUSES) {
      expect(
        screen.getAllByRole('button', { name: new RegExp(STATUS_META[s].label) }).length,
        `${STATUS_META[s].label} is not offered as a filter`,
      ).toBeGreaterThan(0);
    }
  });

  // The rail is the one piece of the row that encodes a number as position, so
  // assert the label it derives rather than the geometry.
  it('shows how long each customer has gone untouched', () => {
    const now = Date.now();
    const daysAgo = (n: number) => new Date(now - n * 86_400_000).toISOString();
    ticketsToReturn = [
      mkTicket({ id: 'fresh', customer_id: 'c1', customer_name: 'Fresh Co',
                 status: 'waiting_on_us', last_message_at: daysAgo(2) }),
      mkTicket({ id: 'stale', customer_id: 'c2', customer_name: 'Stale Co',
                 status: 'waiting_on_us', last_message_at: daysAgo(68) }),
    ];
    render(<SupportTab />);
    const rows = screen.queryAllByRole('table').map(t => t.textContent ?? '').join(' ');
    expect(rows).toContain('2d');
    expect(rows).toContain('2mo');
  });

  it('offers the three saved views with counts', () => {
    const now = Date.now();
    const recent = new Date(now - 86_400_000).toISOString();
    // mkTicket's default created_at is months old, so anything meant to be
    // NOT idle needs an explicit recent touch.
    ticketsToReturn = [
      mkTicket({ id: 'u1', status: 'waiting_on_us', owner_email: null,
                 last_message_at: recent }),
      mkTicket({ id: 'i1', status: 'waiting_on_us', owner_email: 'a@b.io',
                 last_message_at: new Date(now - 90 * 86_400_000).toISOString() }),
      mkTicket({ id: 'r1', status: 'queued_for_replacement', owner_email: 'a@b.io',
                 last_message_at: recent }),
    ];
    render(<SupportTab />);
    expect(screen.getByRole('button', { name: /Unowned/ })).toHaveTextContent('1');
    expect(screen.getByRole('button', { name: /Idle 30 days\+/ })).toHaveTextContent('1');
    expect(screen.getByRole('button', { name: /Replacement queue/ })).toHaveTextContent('1');
  });

  it('filters the table down to a chosen status', () => {
    ticketsToReturn = [
      mkTicket({ id: 'o1', status: 'in_progress', subject: 'Motor stalled' }),
      mkTicket({ id: 'o2', status: 'on_hold', subject: 'Waiting on parts' }),
    ];
    render(<SupportTab />);
    // The status labels also appear on the filter legend, so assert against
    // the row tables only.
    const rows = () => screen.queryAllByRole('table').map(t => t.textContent ?? '').join(' ');
    expect(rows()).toContain('Waiting on parts');

    fireEvent.click(screen.getAllByRole('button', { name: /In Progress/ })[0]);

    expect(rows()).toContain('Motor stalled');
    expect(rows()).not.toContain('Waiting on parts');
  });
});

describe('SupportTab replacement queue labels', () => {
  beforeEach(() => { replacementOrdersToReturn = []; });

  // The status FILTER chips carry the same "Queued for Replacement" text, so
  // assert against the row tables only.
  const tableText = () => screen.getAllByRole('table').map(t => t.textContent ?? '').join(' ');

  it('names the batch a customer is queued for on their row', () => {
    ticketsToReturn = [mkTicket({
      id: 't1', customer_id: 'c1', status: 'queued_for_replacement', replacement_order_id: 'o1',
    })];
    replacementOrdersToReturn = [mkReplacementOrder('o1', [{ kind: 'unit_pending', batch: 'P100X' }])];
    render(<SupportTab />);
    expect(tableText()).toContain('Queued for P100X Replacement');
    // The generic pill is replaced, not duplicated.
    expect(tableText()).not.toContain('Queued for Replacement');
  });

  it('says PARTS when the replacement is parts / consumables', () => {
    ticketsToReturn = [mkTicket({
      id: 't2', customer_id: 'c2', status: 'queued_for_replacement', replacement_order_id: 'o2',
    })];
    replacementOrdersToReturn = [mkReplacementOrder('o2', [{ kind: 'part', sku: 'LILA-LID-V36' }])];
    render(<SupportTab />);
    expect(tableText()).toContain('Queued for PARTS Replacement');
  });

  it('shows one pill per kind when a customer is queued for both', () => {
    ticketsToReturn = [
      mkTicket({ id: 't3', customer_id: 'c3', status: 'queued_for_replacement', replacement_order_id: 'o3' }),
      mkTicket({ id: 't4', customer_id: 'c3', status: 'queued_for_replacement', replacement_order_id: 'o4' }),
    ];
    replacementOrdersToReturn = [
      mkReplacementOrder('o3', [{ kind: 'unit_pending', batch: 'LILA-Mini' }]),
      mkReplacementOrder('o4', [{ kind: 'part', sku: 'LILA-HOPPER' }]),
    ];
    render(<SupportTab />);
    expect(tableText()).toContain('Queued for LILA-Mini Replacement');
    expect(tableText()).toContain('Queued for PARTS Replacement');
  });

  it('falls back to the plain status when no replacement order is linked', () => {
    ticketsToReturn = [mkTicket({ id: 't5', customer_id: 'c5', status: 'queued_for_replacement' })];
    render(<SupportTab />);
    expect(tableText()).toContain('Queued for Replacement');
  });

  // The marker now lives in `tags`, not `status` (migration
  // 20260810120000) — a ticket can be In Progress AND queued for a
  // replacement at the same time. Both must render.
  it('renders the replacement kind from a TAG, not just a status', () => {
    ticketsToReturn = [mkTicket({
      id: 't7', customer_id: 'c7', status: 'in_progress',
      tags: ['queued_for_replacement'], replacement_order_id: 'o7',
    })];
    replacementOrdersToReturn = [mkReplacementOrder('o7', [{ kind: 'unit_pending', batch: 'P100X' }])];
    render(<SupportTab />);
    expect(tableText()).toContain('Queued for P100X Replacement');
    expect(tableText()).toContain('In Progress');
  });

  it('labels an unassigned (customer-less) ticket row too', () => {
    ticketsToReturn = [mkTicket({
      id: 't6', customer_id: null, status: 'queued_for_replacement', replacement_order_id: 'o6',
    })];
    replacementOrdersToReturn = [mkReplacementOrder('o6', [{ kind: 'unit', batch: 'P150' }])];
    render(<SupportTab />);
    expect(tableText()).toContain('Queued for P150 Replacement');
  });
});
