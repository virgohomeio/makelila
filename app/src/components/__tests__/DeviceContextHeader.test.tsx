import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DeviceContextHeader } from '../DeviceContextHeader';
import type { DeviceContext } from '../../lib/service';

// ── Mock useDeviceContext ──────────────────────────────────────────────────────

const { mockCtx } = vi.hoisted(() => ({
  mockCtx: {
    current: {
      unit: null,
      telemetry: null,
      openTicketCount: 0,
      returnCount: 0,
      warranty: { registration: null, loading: false },
      loading: false,
    } satisfies DeviceContext,
  },
}));

vi.mock('../../lib/service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/service')>();
  return {
    ...actual,
    useDeviceContext: (_serial: string | null) => mockCtx.current,
  };
});

// ── Mock UnitTimeline ─────────────────────────────────────────────────────────

vi.mock('../UnitTimeline', () => ({
  UnitTimeline: ({ unitSerial }: { unitSerial: string }) => (
    <div data-testid="unit-timeline">{unitSerial}</div>
  ),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeUnit(overrides: Partial<DeviceContext['unit']> = {}): DeviceContext['unit'] {
  return {
    firmware_version: null,
    electrical_check: null,
    mechanical_check: null,
    defect_notes: null,
    technician: null,
    status_updated_at: null,
    test_report_uploaded_at: null,
    ...overrides,
  };
}

function makeWarrantyReg(
  overrides: Partial<{
    coverage_end: string;
    voided_at: string | null;
    voided_reason: string | null;
  }> = {},
) {
  const future = new Date();
  future.setFullYear(future.getFullYear() + 1);
  return {
    id: 'w1',
    unit_serial: 'LL01-001',
    customer_id: 'cust-1',
    original_order_id: null,
    coverage_tier: 'standard_1y' as const,
    coverage_start: '2025-01-01',
    coverage_end: future.toISOString().slice(0, 10),
    parent_registration_id: null,
    voided_reason: null,
    voided_at: null,
    registered_at: '2025-01-01T00:00:00Z',
    registered_by: null,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('DeviceContextHeader', () => {
  beforeEach(() => {
    mockCtx.current = {
      unit: null,
      telemetry: null,
      openTicketCount: 0,
      returnCount: 0,
      warranty: { registration: null, loading: false },
      loading: false,
    };
  });

  // 1. No unit linked
  it('renders "No unit linked" banner when unitSerial is null', () => {
    render(<DeviceContextHeader unitSerial={null} />);
    expect(screen.getByText(/no unit linked to this ticket/i)).toBeTruthy();
    const linkBtn = screen.getByRole('button', { name: /link unit/i });
    expect((linkBtn as HTMLButtonElement).disabled).toBe(true);
  });

  // 2. Firmware chip colour classes

  it('renders firmware chip green when firmware matches CURRENT_FIRMWARE (1.0.0)', () => {
    mockCtx.current = {
      ...mockCtx.current,
      unit: makeUnit({ firmware_version: '1.0.0' }),
    };
    const { container } = render(<DeviceContextHeader unitSerial="LL01-001" />);
    const greenChip = container.querySelector('[class*="chipGreen"]');
    expect(greenChip?.textContent).toContain('1.0.0');
  });

  it('renders firmware chip amber when firmware is non-null but different', () => {
    mockCtx.current = {
      ...mockCtx.current,
      unit: makeUnit({ firmware_version: '0.9.0' }),
    };
    const { container } = render(<DeviceContextHeader unitSerial="LL01-001" />);
    const amberChip = container.querySelector('[class*="chipAmber"]');
    expect(amberChip?.textContent).toContain('0.9.0');
  });

  it('renders firmware chip grey when firmware_version is null', () => {
    mockCtx.current = {
      ...mockCtx.current,
      unit: makeUnit({ firmware_version: null }),
    };
    render(<DeviceContextHeader unitSerial="LL01-001" />);
    expect(screen.getByText(/firmware unknown/i)).toBeTruthy();
  });

  // 3. Telemetry chip grey when is_stale is true

  it('renders telemetry chip grey and appends "(stale)" when is_stale is true', () => {
    const staleAt = new Date(Date.now() - 30 * 3_600_000).toISOString(); // 30h ago
    mockCtx.current = {
      ...mockCtx.current,
      telemetry: { classified_state: 'OK', classified_at: staleAt, is_stale: true },
    };
    render(<DeviceContextHeader unitSerial="LL01-001" />);
    // Chip text should contain "(stale)"
    expect(screen.getByText(/\(stale\)/i)).toBeTruthy();
  });

  // 4. Warranty badge for each CoverageState

  it('renders warranty badge green for in_warranty with > 30 days remaining', () => {
    const reg = makeWarrantyReg(); // 1 year out
    mockCtx.current = {
      ...mockCtx.current,
      warranty: { registration: reg, loading: false },
    };
    render(<DeviceContextHeader unitSerial="LL01-001" />);
    expect(screen.getByText(/in warranty/i)).toBeTruthy();
  });

  it('renders warranty badge amber when expiry within 30 days', () => {
    const soon = new Date();
    soon.setDate(soon.getDate() + 15);
    const reg = makeWarrantyReg({ coverage_end: soon.toISOString().slice(0, 10) });
    mockCtx.current = {
      ...mockCtx.current,
      warranty: { registration: reg, loading: false },
    };
    render(<DeviceContextHeader unitSerial="LL01-001" />);
    expect(screen.getByText(/expires in/i)).toBeTruthy();
  });

  it('renders warranty badge red for expired', () => {
    const past = new Date();
    past.setFullYear(past.getFullYear() - 1);
    const reg = makeWarrantyReg({ coverage_end: past.toISOString().slice(0, 10) });
    mockCtx.current = {
      ...mockCtx.current,
      warranty: { registration: reg, loading: false },
    };
    render(<DeviceContextHeader unitSerial="LL01-001" />);
    expect(screen.getByText(/^Expired$/)).toBeTruthy();
  });

  it('renders warranty badge red with reason for voided', () => {
    const reg = makeWarrantyReg({
      voided_at: new Date().toISOString(),
      voided_reason: 'tampered',
    });
    mockCtx.current = {
      ...mockCtx.current,
      warranty: { registration: reg, loading: false },
    };
    render(<DeviceContextHeader unitSerial="LL01-001" />);
    expect(screen.getByText(/voided: tampered/i)).toBeTruthy();
  });

  it('renders warranty badge grey for no_registration', () => {
    mockCtx.current = {
      ...mockCtx.current,
      warranty: { registration: null, loading: false },
    };
    render(<DeviceContextHeader unitSerial="LL01-001" />);
    expect(screen.getByText(/no registration/i)).toBeTruthy();
  });

  // 5. Clicking a chip opens the expansion drawer (UnitTimeline appears)

  it('clicking a chip toggles the expansion drawer open, showing UnitTimeline', () => {
    render(<DeviceContextHeader unitSerial="LL01-001" />);
    // Timeline should not be visible initially (drawer closed)
    expect(screen.queryByTestId('unit-timeline')).toBeNull();

    // Click the firmware chip (first chip rendered)
    const chips = screen.getAllByRole('button');
    fireEvent.click(chips[0]);

    // Timeline should now be present in the DOM
    expect(screen.getByTestId('unit-timeline')).toBeTruthy();
  });

  it('clicking the same chip again closes the drawer', () => {
    render(<DeviceContextHeader unitSerial="LL01-001" />);
    const chips = screen.getAllByRole('button');
    fireEvent.click(chips[0]); // open
    expect(screen.getByTestId('unit-timeline')).toBeTruthy();
    fireEvent.click(chips[0]); // close
    expect(screen.queryByTestId('unit-timeline')).toBeNull();
  });
});
