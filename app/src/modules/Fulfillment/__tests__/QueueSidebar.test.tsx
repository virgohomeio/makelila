import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueueSidebar, type QueueOrderSummary } from '../queue/QueueSidebar';
import type { FulfillmentQueueRow } from '../../../lib/fulfillment';

function mkRow(partial: Partial<FulfillmentQueueRow> & { id: string; order_id: string }): FulfillmentQueueRow {
  return {
    step: 1, assigned_serial: null,
    test_report_url: null, test_confirmed_at: null, test_confirmed_by: null,
    carrier: null, tracking_num: null, label_pdf_path: null,
    label_confirmed_at: null, label_confirmed_by: null,
    dock_printed: false, dock_affixed: false, dock_docked: false, dock_notified: false, dock_picked_up: false,
    dock_confirmed_at: null, dock_confirmed_by: null,
    starter_tracking_num: null, email_sent_at: null, email_sent_by: null,
    fulfilled_at: null, fulfilled_by: null,
    due_date: null, priority: false, created_at: '2026-04-19T00:00:00Z',
    ...partial,
  };
}

describe('QueueSidebar', () => {
  // Use local-calendar YYYY-MM-DD (not toISOString which is UTC) so the
  // component's local-TZ comparison agrees no matter where CI runs.
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const row1 = mkRow({ id: 'q1', order_id: 'o1', step: 1, due_date: today });
  const row2 = mkRow({ id: 'q2', order_id: 'o2', step: 3, due_date: '2099-01-01' });
  const shippedRow = mkRow({ id: 'q3', order_id: 'o2', step: 6, fulfilled_at: '2026-06-01T00:00:00Z' });

  const orders = new Map<string, QueueOrderSummary>([
    ['o1', { order_ref: '#1001', customer_name: 'Alice', city: 'Portland', country: 'US' }],
    ['o2', { order_ref: '#1002', customer_name: 'Bob',   city: 'Toronto',  country: 'CA' }],
  ]);

  it('renders ready rows with customer name and step badge', () => {
    render(<MemoryRouter><QueueSidebar readyRows={[row1, row2]} shippedRows={[]} orderLookup={orders} selectedId={null} onSelect={vi.fn()} /></MemoryRouter>);
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('Bob')).toBeInTheDocument();
    expect(screen.getByText('1/6')).toBeInTheDocument();
    expect(screen.getByText('3/6')).toBeInTheDocument();
  });

  it('shows "Due TODAY" for today\'s deadline', () => {
    render(<MemoryRouter><QueueSidebar readyRows={[row1]} shippedRows={[]} orderLookup={orders} selectedId={null} onSelect={vi.fn()} /></MemoryRouter>);
    expect(screen.getByText(/Due TODAY/i)).toBeInTheDocument();
  });

  it('calls onSelect with the row id', () => {
    const onSelect = vi.fn();
    render(<MemoryRouter><QueueSidebar readyRows={[row1, row2]} shippedRows={[]} orderLookup={orders} selectedId={null} onSelect={onSelect} /></MemoryRouter>);
    fireEvent.click(screen.getByText('Alice'));
    expect(onSelect).toHaveBeenCalledWith('q1');
  });

  it('shows empty-state when no ready rows', () => {
    render(<MemoryRouter><QueueSidebar readyRows={[]} shippedRows={[]} orderLookup={orders} selectedId={null} onSelect={vi.fn()} /></MemoryRouter>);
    expect(screen.getByText(/Nothing queued/i)).toBeInTheDocument();
    // The point of the rewrite: an empty queue now says where the next row
    // comes from and offers the way to it, rather than only that it is empty.
    expect(screen.getByRole('button', { name: /go to sales/i })).toBeInTheDocument();
  });

  it('renders a ⭐ priority badge for prioritized rows', () => {
    const pri = mkRow({ id: 'q4', order_id: 'o1', step: 1, priority: true });
    render(<MemoryRouter><QueueSidebar readyRows={[pri]} shippedRows={[]} orderLookup={orders} selectedId={null} onSelect={vi.fn()} /></MemoryRouter>);
    expect(screen.getByTitle(/Priority/i)).toBeInTheDocument();
  });

  it('shows tab buttons with counts', () => {
    render(<MemoryRouter><QueueSidebar readyRows={[row1]} shippedRows={[shippedRow]} orderLookup={orders} selectedId={null} onSelect={vi.fn()} /></MemoryRouter>);
    // Label and count are separate elements now — the count carries the data
    // face so it lines up with every other tab count in the app.
    expect(screen.getByRole('button', { name: /ready to ship 1/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^shipped 1/i })).toBeInTheDocument();
  });

  it('switches to shipped tab and shows shipped orders', () => {
    render(<MemoryRouter><QueueSidebar readyRows={[row1]} shippedRows={[shippedRow]} orderLookup={orders} selectedId={null} onSelect={vi.fn()} /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: /^shipped 1/i }));
    expect(screen.getByText('Bob')).toBeInTheDocument();
    expect(screen.getByText('6/6')).toBeInTheDocument();
  });

  // Replacements arrive in this queue now (Sales no longer has a tab for
  // them), and a replacement is either a whole machine or a $24 lid. A badge
  // that only says "Replacement" makes the operator open every row to find out
  // which, so it carries the item.
  describe('replacement rows', () => {
    const replRow = mkRow({ id: 'q5', order_id: 'o3', step: 1 });
    const withRepl = (extra: Partial<QueueOrderSummary>) => new Map<string, QueueOrderSummary>([
      ...orders,
      ['o3', {
        order_ref: 'R-0067', customer_name: 'Jeff Mottle', city: 'Calgary',
        country: 'CA', kind: 'replacement', ...extra,
      }],
    ]);

    it('names the part being replaced', () => {
      render(<MemoryRouter><QueueSidebar readyRows={[replRow]} shippedRows={[]} orderLookup={withRepl({ line_items: [
        { kind: 'part', part_id: 'P-LID-V36', sku: 'LILA-LID-V36', name: 'Replacement Top Lid (v3.6)', qty: 1, cost_per_unit_usd: 24 },
      ] })} selectedId={null} onSelect={vi.fn()} /></MemoryRouter>);
      expect(screen.getByText('Replacement · lid')).toBeInTheDocument();
    });

    it('names the batch when a whole unit is going out', () => {
      render(<MemoryRouter><QueueSidebar readyRows={[replRow]} shippedRows={[]} orderLookup={withRepl({ line_items: [
        { kind: 'unit', unit_serial: 'LL01-284', batch: 'P100X', name: 'LILA Pro (P100X)', qty: 1, cost_usd: 312 },
      ] })} selectedId={null} onSelect={vi.fn()} /></MemoryRouter>);
      expect(screen.getByText('Replacement · P100X')).toBeInTheDocument();
    });

    it('falls back to a bare badge rather than inventing an item', () => {
      render(<MemoryRouter><QueueSidebar readyRows={[replRow]} shippedRows={[]} orderLookup={withRepl({ line_items: [] })} selectedId={null} onSelect={vi.fn()} /></MemoryRouter>);
      expect(screen.getByText('Replacement')).toBeInTheDocument();
    });

    it('leaves a sale row unbadged', () => {
      render(<MemoryRouter><QueueSidebar readyRows={[row1]} shippedRows={[]} orderLookup={orders} selectedId={null} onSelect={vi.fn()} /></MemoryRouter>);
      expect(screen.queryByText(/^Replacement/)).not.toBeInTheDocument();
    });
  });

  // A row whose machine is already at the customer sits under Shipped. It
  // still carries its half-walked step, so the row has to explain itself.
  describe('already-shipped rows', () => {
    const mark = {
      basis: 'ref' as const,
      serial: 'LL01-00000000252',
      shippedAt: '2026-06-12',
      deliveredAt: null,
    };
    // Step 1 and long overdue — exactly the shape of the six stuck sale orders.
    const stuck = mkRow({ id: 'q9', order_id: 'o1', step: 1, due_date: '2026-06-12' });

    it('badges the row and names the machine that went out', () => {
      render(<MemoryRouter><QueueSidebar
        readyRows={[]} shippedRows={[stuck]} orderLookup={orders}
        shippedMarks={new Map([['q9', mark]])}
        selectedId={null} onSelect={vi.fn()} /></MemoryRouter>);
      fireEvent.click(screen.getByText(/^Shipped/));
      expect(screen.getByText('ALREADY SHIPPED')).toBeInTheDocument();
      expect(screen.getByTitle(/LL01-00000000252/)).toBeInTheDocument();
    });

    it('reads as fulfilled rather than months overdue', () => {
      render(<MemoryRouter><QueueSidebar
        readyRows={[]} shippedRows={[stuck]} orderLookup={orders}
        shippedMarks={new Map([['q9', mark]])}
        selectedId={null} onSelect={vi.fn()} /></MemoryRouter>);
      fireEvent.click(screen.getByText(/^Shipped/));
      expect(screen.getByText('✓ Fulfilled')).toBeInTheDocument();
      expect(screen.queryByText(/OVERDUE/)).not.toBeInTheDocument();
    });

    it('leaves an unmarked row showing its real due state', () => {
      render(<MemoryRouter><QueueSidebar
        readyRows={[stuck]} shippedRows={[]} orderLookup={orders}
        shippedMarks={new Map()}
        selectedId={null} onSelect={vi.fn()} /></MemoryRouter>);
      expect(screen.queryByText('ALREADY SHIPPED')).not.toBeInTheDocument();
      expect(screen.getByText(/OVERDUE/)).toBeInTheDocument();
    });
  });

  // The Shipped tab is a 100+ row history, not a work list. Ordered by order
  // ref it read as noise; an operator looking one up knows roughly *when* it
  // went, so the rail is bucketed by month with the newest at the top.
  describe('shipped tab, by month', () => {
    const june = mkRow({ id: 'qj', order_id: 'o1', step: 6, fulfilled_at: '2026-06-11T10:00:00Z' });
    const sept = mkRow({ id: 'qs', order_id: 'o2', step: 6, fulfilled_at: '2026-09-02T10:00:00Z' });

    const openShipped = (rows: FulfillmentQueueRow[]) => {
      const { container } = render(<MemoryRouter><QueueSidebar
        readyRows={[]} shippedRows={rows} orderLookup={orders}
        selectedId={null} onSelect={vi.fn()} /></MemoryRouter>);
      fireEvent.click(screen.getByRole('button', { name: /^shipped/i }));
      return container;
    };

    it('heads each month and puts the newest one first', () => {
      const container = openShipped([june, sept]);
      const headings = Array.from(container.querySelectorAll('h3')).map(h => h.textContent);
      expect(headings).toEqual(['September 20261', 'June 20261']);
    });

    it('lists the rows under the month they shipped in', () => {
      const container = openShipped([june, sept]);
      // Bob (#1002) shipped in September, Alice (#1001) in June.
      const names = Array.from(container.querySelectorAll('h3, [class*="rowName"]'))
        .map(el => el.textContent?.replace(/\d\/6$/, ''));
      expect(names).toEqual(['September 20261', 'Bob', 'June 20261', 'Alice']);
    });

    it('leaves the ready tab ungrouped', () => {
      const { container } = render(<MemoryRouter><QueueSidebar
        readyRows={[row1]} shippedRows={[june]} orderLookup={orders}
        selectedId={null} onSelect={vi.fn()} /></MemoryRouter>);
      expect(container.querySelectorAll('h3')).toHaveLength(0);
    });

    // Shipped is 100+ rows of archive; scrolling it was the only way in.
    describe('search', () => {
      const search = () => screen.getByLabelText('Search shipped orders');

      it('narrows the list to the matching customer', () => {
        openShipped([june, sept]);
        fireEvent.change(search(), { target: { value: 'ali' } });
        expect(screen.getByText('Alice')).toBeInTheDocument();
        expect(screen.queryByText('Bob')).not.toBeInTheDocument();
      });

      it('drops the months that have no match left', () => {
        const container = openShipped([june, sept]);
        fireEvent.change(search(), { target: { value: 'alice' } });
        const headings = Array.from(container.querySelectorAll('h3')).map(h => h.textContent);
        expect(headings).toEqual(['June 20261']);
      });

      it('matches the order ref with or without its #', () => {
        openShipped([june, sept]);
        fireEvent.change(search(), { target: { value: '1002' } });
        expect(screen.getByText('Bob')).toBeInTheDocument();
        expect(screen.queryByText('Alice')).not.toBeInTheDocument();

        fireEvent.change(search(), { target: { value: '#1002' } });
        expect(screen.getByText('Bob')).toBeInTheDocument();
      });

      it('keeps the tab count showing the whole archive, not the matches', () => {
        openShipped([june, sept]);
        fireEvent.change(search(), { target: { value: 'alice' } });
        expect(screen.getByRole('button', { name: /^shipped/i })).toHaveTextContent('2');
      });

      it('says nothing matched rather than looking like an empty archive', () => {
        openShipped([june, sept]);
        fireEvent.change(search(), { target: { value: 'zzz' } });
        expect(screen.getByText(/No shipped order matches/i)).toBeInTheDocument();
        expect(screen.queryByText(/Nothing shipped yet/i)).not.toBeInTheDocument();
      });

      it('clears back to the full list', () => {
        openShipped([june, sept]);
        fireEvent.change(search(), { target: { value: 'alice' } });
        fireEvent.click(screen.getByLabelText('Clear search'));
        expect(screen.getByText('Alice')).toBeInTheDocument();
        expect(screen.getByText('Bob')).toBeInTheDocument();
      });

      // Looking someone up starts on one tab and usually ends on the other.
      it('carries the query across the tab switch', () => {
        render(<MemoryRouter><QueueSidebar
          readyRows={[row1]} shippedRows={[june, sept]} orderLookup={orders}
          selectedId={null} onSelect={vi.fn()} /></MemoryRouter>);
        fireEvent.change(screen.getByLabelText('Search orders ready to ship'), { target: { value: 'bob' } });
        fireEvent.click(screen.getByRole('button', { name: /^shipped/i }));
        expect(search()).toHaveValue('bob');
        expect(screen.getByText('Bob')).toBeInTheDocument();
        expect(screen.queryByText('Alice')).not.toBeInTheDocument();
      });
    });

    describe('search on the ready tab', () => {
      const readySearch = () => screen.getByLabelText('Search orders ready to ship');
      const openReady = (ready: FulfillmentQueueRow[], shipped: FulfillmentQueueRow[] = []) =>
        render(<MemoryRouter><QueueSidebar
          readyRows={ready} shippedRows={shipped} orderLookup={orders}
          selectedId={null} onSelect={vi.fn()} /></MemoryRouter>).container;

      it('narrows the ready list to the matching customer', () => {
        openReady([row1, row2]);
        fireEvent.change(readySearch(), { target: { value: 'ali' } });
        expect(screen.getByText('Alice')).toBeInTheDocument();
        expect(screen.queryByText('Bob')).not.toBeInTheDocument();
      });

      it('matches the order ref with or without its #', () => {
        openReady([row1, row2]);
        fireEvent.change(readySearch(), { target: { value: '#1002' } });
        expect(screen.getByText('Bob')).toBeInTheDocument();
        expect(screen.queryByText('Alice')).not.toBeInTheDocument();
      });

      it('leaves the ready list ungrouped while searching', () => {
        const container = openReady([row1, row2]);
        fireEvent.change(readySearch(), { target: { value: 'ali' } });
        expect(container.querySelectorAll('h3')).toHaveLength(0);
      });

      it('keeps the tab count on the whole queue, not the matches', () => {
        openReady([row1, row2]);
        fireEvent.change(readySearch(), { target: { value: 'ali' } });
        expect(screen.getByRole('button', { name: /^ready to ship/i })).toHaveTextContent('2');
      });

      it('says nothing matched rather than looking like an empty queue', () => {
        openReady([row1, row2]);
        fireEvent.change(readySearch(), { target: { value: 'zzz' } });
        expect(screen.getByText(/No order ready to ship matches/i)).toBeInTheDocument();
        expect(screen.queryByText(/Nothing queued/i)).not.toBeInTheDocument();
      });

      // The order is not on the floor because it already went out — the miss
      // is the answer, and the other tab is where the answer lives.
      it('points at Shipped when the miss is sitting there', () => {
        openReady([row1], [sept]);
        fireEvent.change(readySearch(), { target: { value: 'bob' } });
        expect(screen.getByText(/1 match under Shipped/i)).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: /look in shipped/i }));
        expect(screen.getByText('Bob')).toBeInTheDocument();
      });

      it('falls back to clearing when neither tab has a match', () => {
        openReady([row1], [sept]);
        fireEvent.change(readySearch(), { target: { value: 'zzz' } });
        expect(screen.queryByText(/match under/i)).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: /show all orders/i }));
        expect(screen.getByText('Alice')).toBeInTheDocument();
      });

      it('has no search box when the queue is empty', () => {
        openReady([]);
        expect(screen.queryByLabelText('Search orders ready to ship')).not.toBeInTheDocument();
        expect(screen.getByText(/Nothing queued/i)).toBeInTheDocument();
      });
    });
  });
});
