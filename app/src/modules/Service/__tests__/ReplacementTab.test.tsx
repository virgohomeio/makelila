import { describe, it, expect, vi } from 'vitest';
import { render as rtlRender, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';
import ReplacementTab from '../ReplacementTab';

// ReplacementTab deep-links to orders (useNavigate/Link), so renders need a Router.
const render = (ui: ReactElement) => rtlRender(<MemoryRouter>{ui}</MemoryRouter>);

vi.mock('../../../lib/orders', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/orders')>('../../../lib/orders');
  return {
    ...actual,
    useReplacementOrders: () => ({
      orders: [
        { id: 'o1', order_ref: 'R-0001', kind: 'replacement', status: 'pending',
          customer_name: 'Linda', cogs_usd: 12.5, shipped_at: null, delivered_at: null,
          created_at: new Date(Date.now() - 86400_000).toISOString(),
          linked_ticket_id: 't1',
          line_items: [{ kind: 'part', part_id: 'p1', sku: 'X', name: 'Hinge', qty: 2, cost_per_unit_usd: 4.2 }] },
        { id: 'o2', order_ref: 'R-0002', kind: 'replacement', status: 'approved',
          customer_name: 'Sam', cogs_usd: 312, shipped_at: null, delivered_at: null,
          created_at: new Date(Date.now() - 2 * 86400_000).toISOString(),
          linked_ticket_id: 't2',
          line_items: [{ kind: 'unit', unit_serial: 'LL01-284', batch: 'B7', name: 'LILA', qty: 1, cost_usd: 312 }] },
      ],
      loading: false,
    }),
  };
});

describe('ReplacementTab', () => {
  it('lists replacement orders with order_ref, customer, COGS, stage', () => {
    render(<ReplacementTab />);
    expect(screen.getByText('R-0001')).toBeInTheDocument();
    expect(screen.getByText('R-0002')).toBeInTheDocument();
    expect(screen.getByText('Linda')).toBeInTheDocument();
    expect(screen.getByText(/\$12\.50/)).toBeInTheDocument();
  });

  it('shows KPI strip totals', () => {
    render(<ReplacementTab />);
    expect(screen.getByText('Open')).toBeInTheDocument();
    const kpiValues = screen.getAllByText('2');
    expect(kpiValues.length).toBeGreaterThan(0);
  });
});

// FR-6: the triage table lists open tickets awaiting a replacement decision.
// It names a person, so it names the primary user — and keeps the purchaser,
// because the replacement ships against their order.
let ticketsToReturn: unknown[] = [];
let customersToReturn: unknown[] = [];
vi.mock('../../../lib/service', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/service')>('../../../lib/service');
  return { ...actual, useServiceTickets: vi.fn(() => ({ tickets: ticketsToReturn, loading: false })) };
});
vi.mock('../../../lib/customers', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/customers')>('../../../lib/customers');
  return { ...actual, useCustomers: vi.fn(() => ({ customers: customersToReturn })) };
});

describe('ReplacementTab — purchaser vs primary user', () => {
  const mkTriageTicket = (over: Record<string, unknown> = {}) => ({
    id: 'tt1', ticket_number: 'TKT-9', subject: 'lid cracked',
    topic: 'warranty_replacement', status: 'waiting_on_us', priority: 'normal',
    replacement_order_id: null, customer_id: 'c-chad', customer_name: 'Chad Wu',
    customer_email: 'chad@example.com', customer_phone: null, tags: [],
    category: 'support', source: 'gmail', created_at: '2026-06-01T00:00:00Z',
    last_message_at: '2026-06-01T00:00:00Z', ...over,
  });

  it('headlines the primary user in the triage row', () => {
    ticketsToReturn = [mkTriageTicket()];
    customersToReturn = [{
      id: 'c-chad', full_name: 'Chad Wu', phone: null, email: 'chad@example.com',
      purchaser_id: null, primary_user_name: 'Sarah Wu', primary_user_phone: null,
      primary_user_email: null, primary_user_relationship: null,
    }];
    render(<ReplacementTab />);
    expect(screen.getAllByText(/Sarah Wu/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Chad Wu/).length).toBeGreaterThan(0);
  });

  it('shows one plain name when the purchaser is the only person', () => {
    ticketsToReturn = [mkTriageTicket()];
    customersToReturn = [{
      id: 'c-chad', full_name: 'Chad Wu', phone: null, email: 'chad@example.com',
      purchaser_id: null, primary_user_name: null, primary_user_phone: null,
      primary_user_email: null, primary_user_relationship: null,
    }];
    render(<ReplacementTab />);
    expect(screen.getAllByText(/Chad Wu/).length).toBeGreaterThan(0);
  });
});
