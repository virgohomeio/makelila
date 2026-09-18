import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

const tote = {
  id: 'C-TOTE', sku: 'LILA-TOTE', name: 'Tote Bag', category: 'consumable', kind: 'tote',
  supplier: null, supplier_url: null, cost_per_unit_usd: null, on_hand: 32, reorder_point: 0,
  demand_override: null, location: null, notes: null, created_at: '', updated_at: '',
};
const lid = {
  ...tote, id: 'P-LID-V36', sku: 'LILA-LID-V36', name: 'Replacement Top Lid (v3.6)',
  category: 'replacement', cost_per_unit_usd: 24, on_hand: 5, reorder_point: 10, demand_override: 9,
};

const updatePartField = vi.fn(async (..._args: unknown[]) => {});
const createPart = vi.fn(async (..._args: unknown[]) => 'C-TOTE');
const refresh = vi.fn(async () => {});
vi.mock('../../../lib/parts', async () => ({
  ...await vi.importActual<typeof import('../../../lib/parts')>('../../../lib/parts'),
  useParts: () => ({ parts: [lid, tote], loading: false, refresh }),
  usePartShipments: () => ({ shipments: [], loading: false }),
  updatePartField: (...args: unknown[]) => updatePartField(...args),
  createPart: (...args: unknown[]) => createPart(...args),
}));
vi.mock('../../../lib/orders', () => ({ useReplacementOrders: () => ({ orders: [] }) }));
vi.mock('../../../lib/customers', () => ({ useCustomers: () => ({ customers: [], loading: false }) }));

import { PartsTab } from '../PartsTab';

const row = (name: string) => screen.getByText(name).closest('tr') as HTMLElement;

describe('Stock › Parts — editable numbers', () => {
  beforeEach(() => { updatePartField.mockClear(); createPart.mockClear(); });

  it('shows a consumable’s on-hand count instead of n/a', () => {
    render(<PartsTab />);
    expect(within(row('Tote Bag')).getByRole('button', { name: 'Edit Tote Bag on hand' })).toHaveTextContent('32');
  });

  it('saves a typed on-hand count on Enter', async () => {
    render(<PartsTab />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit Tote Bag on hand' }));
    const input = screen.getByRole('textbox', { name: 'Tote Bag on hand' });
    fireEvent.change(input, { target: { value: '40' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(updatePartField).toHaveBeenCalledWith(tote, 'on_hand', 40));
  });

  it('shows a manual demand override and clears it back to auto when blanked', async () => {
    render(<PartsTab />);
    const cell = screen.getByRole('button', { name: /Edit Replacement Top Lid \(v3\.6\) demand/ });
    expect(cell).toHaveTextContent('manual');
    expect(cell).toHaveTextContent('9');
    fireEvent.click(cell);
    const input = screen.getByRole('textbox', { name: 'Replacement Top Lid (v3.6) demand' });
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    await waitFor(() => expect(updatePartField).toHaveBeenCalledWith(lid, 'demand_override', null));
  });

  it('rejects a negative count without writing, and Escape cancels', () => {
    render(<PartsTab />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit Tote Bag reorder at' }));
    const input = screen.getByRole('textbox', { name: 'Tote Bag reorder at' });
    fireEvent.change(input, { target: { value: '-3' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(updatePartField).not.toHaveBeenCalled();
    expect(screen.getByText(/whole number of 0 or more/)).toBeInTheDocument();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('textbox', { name: 'Tote Bag reorder at' })).toBeNull();
  });

  it('saves cost as dollars', async () => {
    render(<PartsTab />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit Tote Bag cost' }));
    const input = screen.getByRole('textbox', { name: 'Tote Bag cost' });
    fireEvent.change(input, { target: { value: '$3.75' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(updatePartField).toHaveBeenCalledWith(tote, 'cost_per_unit_usd', 3.75));
  });
});

describe('Stock › Parts — adding a SKU', () => {
  beforeEach(() => { createPart.mockClear(); refresh.mockClear(); });

  const open = () => {
    render(<PartsTab />);
    fireEvent.click(screen.getByRole('button', { name: '+ Add part / consumable' }));
  };

  it('creates a consumable with the count typed in, then re-reads the table', async () => {
    open();
    fireEvent.change(screen.getByLabelText('SKU'), { target: { value: 'LILA-MAGNET' } });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Magnet' } });
    fireEvent.change(screen.getByLabelText('On hand'), { target: { value: '32' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add to inventory' }));

    await waitFor(() => expect(createPart).toHaveBeenCalledTimes(1));
    const [input, existingIds] = createPart.mock.calls[0] as [Record<string, unknown>, string[]];
    expect(input).toMatchObject({
      sku: 'LILA-MAGNET', name: 'Magnet', category: 'consumable',
      on_hand: 32, reorder_point: 0, cost_per_unit_usd: null, supplier: null,
    });
    expect(existingIds).toEqual(['P-LID-V36', 'C-TOTE']);
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('refuses a SKU that already exists', () => {
    open();
    fireEvent.change(screen.getByLabelText('SKU'), { target: { value: 'lila-tote' } });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Tote Bag' } });
    expect(screen.getByRole('button', { name: 'Add to inventory' })).toBeDisabled();
    expect(createPart).not.toHaveBeenCalled();
  });

  it('refuses a negative on-hand count', async () => {
    open();
    fireEvent.change(screen.getByLabelText('SKU'), { target: { value: 'LILA-MAGNET' } });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Magnet' } });
    fireEvent.change(screen.getByLabelText('On hand'), { target: { value: '-4' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add to inventory' }));
    await waitFor(() => expect(screen.getByText(/whole numbers of 0 or more/)).toBeInTheDocument());
    expect(createPart).not.toHaveBeenCalled();
  });

  it('surfaces a write failure instead of closing the form', async () => {
    createPart.mockRejectedValueOnce(new Error('new row violates row-level security policy'));
    open();
    fireEvent.change(screen.getByLabelText('SKU'), { target: { value: 'LILA-MAGNET' } });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Magnet' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add to inventory' }));
    await waitFor(() => expect(screen.getByText(/row-level security/)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Add to inventory' })).toBeInTheDocument();
  });
});
