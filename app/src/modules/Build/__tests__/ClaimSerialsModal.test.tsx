// Build › "+ Claim serials": one serial or a whole range, under a batch and
// optionally a PO. The preview is planned against the units already loaded.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { FactoryOrder, RangeClaimResult } from '../../../lib/build';

const claimSerialRange = vi.fn(async (..._args: unknown[]): Promise<RangeClaimResult> =>
  ({ created: [], linked: [], skipped: [] }));
const assignSerial = vi.fn(async (..._args: unknown[]) => {});
vi.mock('../../../lib/build', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../lib/build')>(),
  claimSerialRange: (...a: unknown[]) => claimSerialRange(...a),
  assignSerial: (...a: unknown[]) => assignSerial(...a),
}));

import { ClaimSerialsModal } from '../ClaimSerialsModal';

const S = (n: number) => `LL01-${String(n).padStart(11, '0')}`;
const order = (over: Partial<FactoryOrder> = {}): FactoryOrder => ({
  id: 'po1', po_number: 'PO-1012', batch: 'P300', qty_ordered: 90, unit_cost_usd: null,
  manufacturer: 'LC', ship_target_date: null, status: 'placed', notes: null,
  placed_at: '2026-10-01T00:00:00Z', placed_by: null,
  created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z',
  ...over,
});
const batches = [{ id: 'P100' }, { id: 'P300' }];
const loadedUnits = [
  { serial: S(691), batch: 'P300', po_id: null },
  { serial: S(692), batch: 'P100', po_id: null },
];

function open(orders: FactoryOrder[] = [order()]) {
  const onClose = vi.fn();
  render(<ClaimSerialsModal batches={batches} orders={orders} units={loadedUnits} onClose={onClose} />);
  return { onClose };
}
const pickPo = (id: string) =>
  fireEvent.change(screen.getByLabelText('Purchase order'), { target: { value: id } });
const range = (a: string, b: string) => {
  fireEvent.change(screen.getByLabelText('First serial'), { target: { value: a } });
  fireEvent.change(screen.getByLabelText('Last serial'), { target: { value: b } });
};

describe('ClaimSerialsModal', () => {
  beforeEach(() => { claimSerialRange.mockClear(); assignSerial.mockClear(); });

  it("picking a PO locks the batch to the PO's batch", () => {
    open();
    const batch = screen.getByLabelText('Batch') as HTMLSelectElement;
    expect(batch.value).toBe('P100');
    expect(batch).not.toBeDisabled();
    pickPo('po1');
    expect(batch.value).toBe('P300');
    expect(batch).toBeDisabled();
  });

  it('does not offer cancelled POs', () => {
    open([order(), order({ id: 'po2', po_number: 'PO-0999', status: 'cancelled' })]);
    const options = Array.from((screen.getByLabelText('Purchase order') as HTMLSelectElement).options).map(o => o.text);
    expect(options).toEqual(['No PO', 'PO-1012 · P300']);
  });

  it('previews the range against loaded units', () => {
    open();
    pickPo('po1');
    range('691', '700');
    expect(screen.getByText('8 new · 1 to link · 1 skipped')).toBeInTheDocument();
    expect(screen.getByText('PO PO-1012: 9 of 90 ordered after this')).toBeInTheDocument();
    expect(screen.queryByText(/more than PO/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Create 8 units' })).toBeEnabled();
  });

  it('warns, without blocking, when the PO would go over its ordered quantity', () => {
    open([order({ qty_ordered: 5 })]);
    pickPo('po1');
    range('691', '700');
    expect(screen.getByText('That is more than PO PO-1012 ordered.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create 8 units' })).toBeEnabled();
  });

  it('blocks a reversed range', () => {
    open();
    range('700', '691');
    expect(screen.getByText('The first serial must not come after the last')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create units' })).toBeDisabled();
  });

  it('blocks text that is not a serial', () => {
    open();
    range('69a', '700');
    expect(screen.getByText('Enter a serial like 691 or LL01-00000000691')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create units' })).toBeDisabled();
  });

  it('blocks a PO whose batch has no batch record', () => {
    open([order({ batch: 'P200' })]);
    pickPo('po1');
    range('691', '700');
    expect(screen.getByText('Batch P200 has no batch record yet. Add it on the LILA Units tab first.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create units' })).toBeDisabled();
  });

  it('submits the range with the PO and shows what happened', async () => {
    claimSerialRange.mockResolvedValueOnce({
      created: [693, 694, 695, 696, 697, 698, 699, 700].map(S),
      linked: [S(691)],
      skipped: [{ serial: S(692), reason: 'other_batch', detail: 'P100' }],
    });
    open();
    pickPo('po1');
    range('691', '700');
    fireEvent.click(screen.getByRole('button', { name: 'Create 8 units' }));
    await waitFor(() => expect(claimSerialRange).toHaveBeenCalledWith({
      from: 691, to: 700, batch: 'P300', po: { id: 'po1', po_number: 'PO-1012' },
    }));
    expect(await screen.findByText(/linked to PO/)).toHaveTextContent('8 created · 1 linked to PO · 1 skipped');
    expect(screen.getByText(`${S(692)}: already in batch P100`)).toBeInTheDocument();
  });

  it('single mode creates one unit under the PO', async () => {
    const { onClose } = open();
    pickPo('po1');
    fireEvent.click(screen.getByRole('button', { name: 'One serial' }));
    fireEvent.change(screen.getByLabelText('Serial'), { target: { value: '701' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create unit' }));
    await waitFor(() => expect(assignSerial).toHaveBeenCalledWith({ serial: S(701), batch: 'P300', po_id: 'po1' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});
