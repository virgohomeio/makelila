import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ReplacementPickerModal from '../ReplacementPickerModal';

vi.mock('../../../lib/parts', () => ({
  useParts: () => ({
    parts: [
      { id: 'p1', sku: 'HINGE', name: 'Lid Hinge', category: 'replacement',
        on_hand: 5, cost_per_unit_usd: 4.2 },
      { id: 'p2', sku: 'MOTOR', name: 'Chamber Motor', category: 'replacement',
        on_hand: 0, cost_per_unit_usd: 42.0 },  // out of stock — should be filtered out
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
}));
vi.mock('../../../lib/orders', () => ({
  createReplacementOrder: vi.fn().mockResolvedValue({ id: 'o1', order_ref: 'R-0001' }),
}));
import { createReplacementOrder } from '../../../lib/orders';

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

  it('lists only in-stock parts and ready units in the picker', () => {
    render(<ReplacementPickerModal ticket={TICKET} address={ADDRESS}
      onClose={() => {}} onCreated={() => {}} />);
    expect(screen.getByText('Lid Hinge')).toBeInTheDocument();
    expect(screen.getByText('LL01-284')).toBeInTheDocument();
    expect(screen.queryByText('Chamber Motor')).not.toBeInTheDocument();
    expect(screen.queryByText('LL01-300')).not.toBeInTheDocument();
  });

  it('adds parts to cart and recomputes COGS on qty change', () => {
    render(<ReplacementPickerModal ticket={TICKET} address={ADDRESS}
      onClose={() => {}} onCreated={() => {}} />);
    fireEvent.click(screen.getByText('Lid Hinge'));
    expect(screen.getByText(/COGS total/)).toHaveTextContent('$4.20');
    fireEvent.click(screen.getByLabelText('Increase Lid Hinge qty'));
    expect(screen.getByText(/COGS total/)).toHaveTextContent('$8.40');
  });

  it('cannot add the same unit twice', () => {
    render(<ReplacementPickerModal ticket={TICKET} address={ADDRESS}
      onClose={() => {}} onCreated={() => {}} />);
    fireEvent.click(screen.getByText('LL01-284'));
    fireEvent.click(screen.getByText('LL01-284'));
    // One in picker still, one in cart row, none duplicated in cart
    // Just verify that the cart only has one unit line:
    expect(screen.getAllByText(/LL01-284/)).toHaveLength(2);  // picker + cart
  });

  it('confirm calls createReplacementOrder with the cart contents', async () => {
    const onCreated = vi.fn();
    render(<ReplacementPickerModal ticket={TICKET} address={ADDRESS}
      onClose={() => {}} onCreated={onCreated} />);
    fireEvent.click(screen.getByText('Lid Hinge'));
    fireEvent.click(screen.getByText('LL01-284'));
    fireEvent.click(screen.getByRole('button', { name: /create replacement order/i }));
    await waitFor(() => expect(createReplacementOrder).toHaveBeenCalledTimes(1));
    const arg = (createReplacementOrder as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg.ticket_id).toBe('t1');
    expect(arg.line_items).toHaveLength(2);
    expect(arg.line_items.find((l: { kind: string }) => l.kind === 'part').sku).toBe('HINGE');
    expect(arg.line_items.find((l: { kind: string }) => l.kind === 'unit').unit_serial).toBe('LL01-284');
    expect(onCreated).toHaveBeenCalledWith({ id: 'o1', order_ref: 'R-0001' });
  });
});
