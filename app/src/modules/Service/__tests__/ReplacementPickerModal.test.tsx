import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ReplacementPickerModal from '../ReplacementPickerModal';

vi.mock('../../../lib/parts', () => ({
  useParts: () => ({
    parts: [
      { id: 'p1', sku: 'HINGE', name: 'Lid Hinge', category: 'replacement',
        on_hand: 5, cost_per_unit_usd: 4.2 },
      { id: 'p2', sku: 'MOTOR', name: 'Chamber Motor', category: 'replacement',
        on_hand: 0, cost_per_unit_usd: 42.0 },  // out of stock — now shown under "Parts (Out of Stock)"
    ],
    loading: false,
  }),
}));
vi.mock('../../../lib/stock', () => ({
  useUnits: () => ({
    units: [
      { serial: 'LL01-284', batch: 'B7', status: 'ready', color: 'White' },
      { serial: 'LL01-300', batch: 'B7', status: 'shipped', color: 'White' },  // not ready — filtered out
    ],
    loading: false,
  }),
  useBatches: () => ({
    batches: [
      { id: 'B7', unit_cost_usd: 312, arrived_at: '2026-01-01', version: null, manufacturer: 'X' },  // arrived → not pending
      { id: 'P100X', unit_cost_usd: null, arrived_at: null, version: null, manufacturer: 'X' },       // not arrived → Pending Batch
    ],
    loading: false,
  }),
}));
vi.mock('../../../lib/orders', () => ({
  createReplacementOrder: vi.fn().mockResolvedValue({ id: 'o1', order_ref: 'R-0001' }),
  createPendingReplacement: vi.fn().mockResolvedValue({ id: 'o2', order_ref: 'R-0002' }),
  hasPendingLine: (items: Array<{ kind: string }>) =>
    items.some(li => li.kind === 'part_pending' || li.kind === 'unit_pending'),
}));
import { createReplacementOrder, createPendingReplacement } from '../../../lib/orders';

const TICKET = {
  id: 't1',
  customer_name: 'Linda Smith',
  customer_email: 'linda@example.com',
  customer_phone: null,
  ticket_number: 'T-138',
};

const ADDRESS = {
  address_line: '123 Maple Lane',
  city: 'Toronto',
  region_state: 'ON',
  country: 'CA' as const,
  postal_code: 'M5J 2N8',
};

describe('ReplacementPickerModal', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows all four sections: in-stock parts, ready units, out-of-stock parts, pending batch', () => {
    render(<ReplacementPickerModal ticket={TICKET} address={ADDRESS}
      onClose={() => {}} onCreated={() => {}} />);
    expect(screen.getByText('Parts (In Stock)')).toBeInTheDocument();
    expect(screen.getByText('Lid Hinge')).toBeInTheDocument();
    expect(screen.getByText('Replacement Units Available')).toBeInTheDocument();
    expect(screen.getByText('LL01-284')).toBeInTheDocument();
    expect(screen.getByText('Parts (Out of Stock)')).toBeInTheDocument();
    expect(screen.getByText('Chamber Motor')).toBeInTheDocument();
    expect(screen.getByText('Pending Batch')).toBeInTheDocument();
    expect(screen.getByText('P100X')).toBeInTheDocument();   // not-arrived batch
    // ready batch B7 is NOT offered as a pending batch
    expect(screen.queryByText(/^B7$/)).not.toBeInTheDocument();
  });

  it('adds parts to cart and recomputes COGS on qty change', () => {
    render(<ReplacementPickerModal ticket={TICKET} address={ADDRESS}
      onClose={() => {}} onCreated={() => {}} />);
    fireEvent.click(screen.getByText('Lid Hinge'));
    expect(screen.getByText(/COGS total/)).toHaveTextContent('$4.20');
    fireEvent.click(screen.getByLabelText('Increase Lid Hinge qty'));
    expect(screen.getByText(/COGS total/)).toHaveTextContent('$8.40');
  });

  it('all-in-stock selection → "Create replacement order" → createReplacementOrder', async () => {
    const onCreated = vi.fn();
    render(<ReplacementPickerModal ticket={TICKET} address={ADDRESS}
      onClose={() => {}} onCreated={onCreated} />);
    fireEvent.click(screen.getByText('Lid Hinge'));
    fireEvent.click(screen.getByText('LL01-284'));
    fireEvent.click(screen.getByRole('button', { name: /^create replacement order$/i }));
    await waitFor(() => expect(createReplacementOrder).toHaveBeenCalledTimes(1));
    expect(createPendingReplacement).not.toHaveBeenCalled();
    const arg = (createReplacementOrder as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg.line_items).toHaveLength(2);
    expect(arg.line_items.find((l: { kind: string }) => l.kind === 'part').sku).toBe('HINGE');
    expect(arg.line_items.find((l: { kind: string }) => l.kind === 'unit').unit_serial).toBe('LL01-284');
    expect(onCreated).toHaveBeenCalledWith({ id: 'o1', order_ref: 'R-0001' });
  });

  it('out-of-stock part selected → button flips to "Create pending replacement" → createPendingReplacement', async () => {
    render(<ReplacementPickerModal ticket={TICKET} address={ADDRESS}
      onClose={() => {}} onCreated={() => {}} />);
    fireEvent.click(screen.getByText('Chamber Motor'));   // out-of-stock → part_pending
    fireEvent.click(screen.getByRole('button', { name: /^create pending replacement$/i }));
    await waitFor(() => expect(createPendingReplacement).toHaveBeenCalledTimes(1));
    expect(createReplacementOrder).not.toHaveBeenCalled();
    const arg = (createPendingReplacement as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg.line_items[0].kind).toBe('part_pending');
  });

  it('pending batch selected → "Create pending replacement" with a unit_pending line', async () => {
    render(<ReplacementPickerModal ticket={TICKET} address={ADDRESS}
      onClose={() => {}} onCreated={() => {}} />);
    fireEvent.click(screen.getByText('P100X'));
    fireEvent.click(screen.getByRole('button', { name: /^create pending replacement$/i }));
    await waitFor(() => expect(createPendingReplacement).toHaveBeenCalledTimes(1));
    const arg = (createPendingReplacement as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg.line_items[0]).toMatchObject({ kind: 'unit_pending', batch: 'P100X' });
  });
});
