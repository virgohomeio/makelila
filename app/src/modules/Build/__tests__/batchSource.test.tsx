import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import Build from '../index';

vi.mock('../../../lib/build', () => ({
  useFactoryOrders: () => ({ orders: [], loading: false }),
  useFreightShipments: () => ({ shipments: [], loading: false }),
  useBuildDefects: () => ({ defects: [], loading: false }),
  useBurnInTests: () => ({ tests: [], loading: false }),
  assignSerial: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../lib/stock', () => ({
  useUnits: () => ({ units: [], loading: false }),
  // Mirrors the `batches` table the Stock > LILA Units tab reads — includes
  // P50 and a batch added via "+ Add batch" (P300), and no P200 / LILA-Mini.
  useBatches: () => ({
    batches: [
      { id: 'P50', arrived_at: '2025-02-15' },
      { id: 'P150', arrived_at: '2025-08-15' },
      { id: 'P50N', arrived_at: '2025-12-05' },
      { id: 'P100', arrived_at: '2026-05-01' },
      { id: 'P100X', arrived_at: null },
      { id: 'P300', arrived_at: null },
    ],
    loading: false,
  }),
}));
vi.mock('../../../lib/orders', () => ({
  useReplacementOrders: () => ({ orders: [] }),
}));
vi.mock('../../../lib/useMediaQuery', () => ({ useIsMobile: () => false }));
vi.mock('../PipelineBoard', () => ({ PipelineBoard: () => null }));
vi.mock('../TableView', () => ({ TableView: () => null }));
vi.mock('../NewPOModal', () => ({ NewPOModal: () => null }));
vi.mock('../BuildQCDashboard', () => ({ BuildQCDashboard: () => null }));
import { assignSerial } from '../../../lib/build';

function openClaim() {
  render(<Build />);
  fireEvent.click(screen.getByRole('button', { name: '+ Claim serial' }));
  return screen.getByRole('combobox');
}

describe('Build › batch lists', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lists exactly the batches from the batches table', () => {
    const select = openClaim();
    const options = within(select).getAllByRole('option').map(o => (o as HTMLOptionElement).value);
    expect(options).toEqual(['P50', 'P150', 'P50N', 'P100', 'P100X', 'P300']);
  });

  it('batch filter chips come from the batches table', () => {
    render(<Build />);
    for (const id of ['All', 'P50', 'P150', 'P50N', 'P100', 'P100X', 'P300']) {
      expect(screen.getByRole('button', { name: id })).toBeInTheDocument();
    }
    expect(screen.queryByRole('button', { name: 'P200' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'LILA-Mini' })).toBeNull();
  });

  it('claims against the selected batch', async () => {
    const select = openClaim();
    expect((select as HTMLSelectElement).value).toBe('P100');
    fireEvent.change(select, { target: { value: 'P300' } });
    fireEvent.change(screen.getByPlaceholderText('LL01-00000000XYZ'), { target: { value: 'LL01-00000000123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create unit' }));
    await vi.waitFor(() =>
      expect(assignSerial).toHaveBeenCalledWith({ serial: 'LL01-00000000123', batch: 'P300' }));
  });
});
