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
