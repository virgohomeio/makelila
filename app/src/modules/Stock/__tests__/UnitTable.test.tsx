// The Stock table surfaces a shared MAC on every unit holding it, and the QC
// modal lets an operator see, correct or clear a unit's MAC. The flag is
// derived from the units list (findMacDuplicates), so the table just renders
// whatever map it is handed.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import type { Unit } from '../../../lib/stock';

const updateUnitFields = vi.fn(async (..._args: unknown[]) => {});
vi.mock('../../../lib/stock', async () => ({
  ...await vi.importActual<typeof import('../../../lib/stock')>('../../../lib/stock'),
  updateUnitStatus: vi.fn(async () => {}),
  updateUnitFields: (...args: unknown[]) => updateUnitFields(...args),
  linkUnitToCustomer: vi.fn(async () => {}),
}));
vi.mock('../../../lib/customers', () => ({ useCustomers: () => ({ customers: [], loading: false }) }));
vi.mock('../../../lib/fulfillment', () => ({
  assignUnit: vi.fn(async () => {}),
  fetchUnassignedQueueItems: vi.fn(async () => []),
}));
vi.mock('../../../lib/testReports', async () => ({
  ...await vi.importActual<typeof import('../../../lib/testReports')>('../../../lib/testReports'),
  openTestReport: vi.fn(async () => {}),
}));
vi.mock('../../../components/UnitTimeline', () => ({ UnitTimeline: () => null }));

import { UnitTable } from '../UnitTable';

const MAC = '98:a3:16:a6:97:b0';

const unit = (serial: string, over: Partial<Unit> = {}): Unit => ({
  serial, batch: 'P100', status: 'ready', color: 'White', location: null,
  customer_name: null, customer_id: null, customer_order_ref: null, carrier: null,
  firmware_version: null, defect_reason: null, tracking_num: null, shipped_at: null,
  notes: null, status_updated_at: '2026-10-01T00:00:00Z', status_updated_by: null,
  created_at: '2026-09-01T00:00:00Z', technician: null, electrical_check: 'pass',
  mechanical_check: null, defect_notes: null, electrical_failed_tests: null,
  test_report_path: null, test_report_name: null, test_report_uploaded_at: null,
  is_team_test: false, backfilled_at: null, backfill_source: null, mac_address: null, po_id: null,
  ...over,
});

const row = (serial: string) => screen.getByText(serial).closest('tr') as HTMLElement;

describe('UnitTable — duplicate MAC', () => {
  beforeEach(() => updateUnitFields.mockClear());

  it('shows a DUP MAC pill only on units in the duplicate map, naming the other serial', () => {
    const units = [unit('LL01-A', { mac_address: MAC }), unit('LL01-B', { mac_address: MAC }), unit('LL01-C')];
    const macDupes = new Map([['LL01-A', ['LL01-B']], ['LL01-B', ['LL01-A']]]);
    render(<UnitTable units={units} macDupes={macDupes} />);
    expect(within(row('LL01-A')).getByText('DUP MAC')).toHaveAttribute('title', 'Same MAC as LL01-B');
    expect(within(row('LL01-B')).getByText('DUP MAC')).toHaveAttribute('title', 'Same MAC as LL01-A');
    expect(within(row('LL01-C')).queryByText('DUP MAC')).toBeNull();
  });

  it('renders without a duplicate map at all', () => {
    render(<UnitTable units={[unit('LL01-A', { mac_address: MAC })]} />);
    expect(screen.queryByText('DUP MAC')).toBeNull();
  });

  it('QC modal shows the MAC and names the other unit holding it', () => {
    const macDupes = new Map([['LL01-A', ['LL01-B']]]);
    render(<UnitTable units={[unit('LL01-A', { mac_address: MAC })]} macDupes={macDupes} />);
    fireEvent.click(within(row('LL01-A')).getByTitle(/Technician:/));
    expect(screen.getByLabelText('MAC address')).toHaveValue(MAC);
    expect(screen.getByText('Also on LL01-B')).toBeInTheDocument();
  });

  it('saves a corrected MAC in normalised form', async () => {
    render(<UnitTable units={[unit('LL01-A', { mac_address: MAC })]} />);
    fireEvent.click(within(row('LL01-A')).getByTitle(/Technician:/));
    fireEvent.change(screen.getByLabelText('MAC address'), { target: { value: ' 98-A3-16-A6-97-B1 ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save QC' }));
    await waitFor(() => expect(updateUnitFields).toHaveBeenCalled());
    expect(updateUnitFields.mock.calls[0][1]).toMatchObject({ mac_address: '98:a3:16:a6:97:b1' });
  });

  it('clears the MAC when the field is blanked', async () => {
    render(<UnitTable units={[unit('LL01-A', { mac_address: MAC })]} />);
    fireEvent.click(within(row('LL01-A')).getByTitle(/Technician:/));
    fireEvent.change(screen.getByLabelText('MAC address'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save QC' }));
    await waitFor(() => expect(updateUnitFields).toHaveBeenCalled());
    expect(updateUnitFields.mock.calls[0][1]).toMatchObject({ mac_address: null });
  });

  it('rejects a malformed MAC without writing', async () => {
    render(<UnitTable units={[unit('LL01-A')]} />);
    fireEvent.click(within(row('LL01-A')).getByTitle(/Technician:/));
    fireEvent.change(screen.getByLabelText('MAC address'), { target: { value: '98:a3:16' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save QC' }));
    expect(await screen.findByText('MAC must be six hex pairs, e.g. 98:a3:16:a6:97:b0')).toBeInTheDocument();
    expect(updateUnitFields).not.toHaveBeenCalled();
  });
});
