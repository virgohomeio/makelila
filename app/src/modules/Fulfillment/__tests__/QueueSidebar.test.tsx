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
});
