import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render as rtlRender, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';
import ReplacementTab from '../ReplacementTab';

// ReplacementTab deep-links to orders (useNavigate/Link), so renders need a Router.
const render = (ui: ReactElement) => rtlRender(<MemoryRouter>{ui}</MemoryRouter>);

// This tab is the only way a replacement raised before 0fb7f45 can reach the
// fulfillment queue — Sales stopped listing kind='replacement', taking the last
// button that could queue one with it.
const { queueSpy, queueState } = vi.hoisted(() => ({
  queueSpy: vi.fn(),
  queueState: { rows: [] as Array<{ order_id: string; step: number }> },
}));

vi.mock('../../../lib/fulfillment', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/fulfillment')>('../../../lib/fulfillment');
  return {
    ...actual,
    useFulfillmentQueue: () => ({
      all: queueState.rows, ready: [], fulfilled: [], loading: false,
    }),
  };
});

vi.mock('../../../lib/orders', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/orders')>('../../../lib/orders');
  return {
    ...actual,
    queueReplacementForFulfillment: queueSpy,
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

// Which replacements are actually in Fulfillment › Queue, and how one gets
// there. Queue membership is read from fulfillment_queue rather than inferred
// from orders.status — inferring it is what the deleted Sales tab did, filtering
// on replacement_state while Confirm wrote status, and the two disagreeing is
// why that tab had to go.
describe('ReplacementTab — getting a replacement into the queue', () => {
  beforeEach(() => {
    ticketsToReturn = [];
    customersToReturn = [];
    queueState.rows = [];
    queueSpy.mockReset();
    queueSpy.mockResolvedValue({ queued: true });
  });

  it('offers "Ready to Ship" for a live replacement with no queue row', () => {
    render(<ReplacementTab />);
    expect(screen.getAllByRole('button', { name: 'Ready to Ship' })).toHaveLength(2);
  });

  it('shows the step instead of the button once the order is queued', () => {
    queueState.rows = [{ order_id: 'o1', step: 3 }];
    render(<ReplacementTab />);
    expect(screen.getByText('In queue · step 3')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Ready to Ship' })).toHaveLength(1);
  });

  it('counts what is NOT in the queue — the number that went missing with the Sales tab', () => {
    queueState.rows = [{ order_id: 'o1', step: 3 }];
    render(<ReplacementTab />);
    const kpi = screen.getByText('Not in queue').parentElement!;
    expect(kpi.textContent).toContain('1');
  });

  // /order-review/:id resolves out of bucketOrders' `all` + `cancelled`, and
  // 0fb7f45 made both sales-only. Every replacement deep link has pointed at a
  // detail pane that renders its empty state ever since — including the one the
  // ticket panel navigates to the moment a replacement is created.
  it('does not link the order ref into Order Review, which cannot resolve a replacement', () => {
    render(<ReplacementTab />);
    expect(screen.getByText('R-0001').closest('a')).toBeNull();
  });

  it('queues the order the button belongs to', async () => {
    render(<ReplacementTab />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Ready to Ship' })[0]);
    await waitFor(() => expect(queueSpy).toHaveBeenCalledWith('o1'));
  });

  it('asks before queueing an order the stock check says is short', async () => {
    queueSpy.mockResolvedValueOnce({ queued: false, blocked: 'Hinge' });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(<ReplacementTab />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Ready to Ship' })[0]);

    await waitFor(() => expect(queueSpy).toHaveBeenCalledTimes(2));
    expect(confirm.mock.calls[0][0]).toContain('Hinge');
    // Only the second call overrides — the first must never force silently.
    expect(queueSpy).toHaveBeenNthCalledWith(2, 'o1', { force: true });
    confirm.mockRestore();
  });

  it('leaves the order alone when the operator declines the override', async () => {
    queueSpy.mockResolvedValueOnce({ queued: false, blocked: 'Hinge' });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);

    render(<ReplacementTab />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Ready to Ship' })[0]);

    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(queueSpy).toHaveBeenCalledTimes(1);
    confirm.mockRestore();
  });
});
