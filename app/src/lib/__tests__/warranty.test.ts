import { describe, it, expect } from 'vitest';
import {
  computeCoverageState,
  daysRemainingWarranty,
  type WarrantyRegistration,
} from '../service';

function makeReg(overrides: Partial<WarrantyRegistration> = {}): WarrantyRegistration {
  const today = new Date();
  const futureEnd = new Date(today);
  futureEnd.setFullYear(futureEnd.getFullYear() + 1);
  return {
    id: 'test-id',
    unit_serial: 'LL01-00000000251',
    customer_id: 'cust-1',
    original_order_id: null,
    coverage_tier: 'standard_1y',
    coverage_start: today.toISOString().slice(0, 10),
    coverage_end: futureEnd.toISOString().slice(0, 10),
    parent_registration_id: null,
    voided_reason: null,
    voided_at: null,
    registered_at: today.toISOString(),
    ...overrides,
  };
}

describe('computeCoverageState', () => {
  it('returns no_registration when reg is null', () => {
    expect(computeCoverageState(null)).toBe('no_registration');
  });

  it('returns in_warranty when coverage_end is in the future', () => {
    const future = new Date();
    future.setFullYear(future.getFullYear() + 1);
    const reg = makeReg({ coverage_end: future.toISOString().slice(0, 10) });
    expect(computeCoverageState(reg)).toBe('in_warranty');
  });

  it('returns expired when coverage_end is in the past', () => {
    const past = new Date();
    past.setFullYear(past.getFullYear() - 1);
    const reg = makeReg({ coverage_end: past.toISOString().slice(0, 10) });
    expect(computeCoverageState(reg)).toBe('expired');
  });

  it('returns expired for replacement_no_warranty where coverage_end equals coverage_start (yesterday)', () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const dateStr = yesterday.toISOString().slice(0, 10);
    const reg = makeReg({
      coverage_tier: 'replacement_no_warranty',
      coverage_start: dateStr,
      coverage_end: dateStr,
    });
    expect(computeCoverageState(reg)).toBe('expired');
  });

  it('returns voided when voided_at is set', () => {
    const reg = makeReg({ voided_at: new Date().toISOString(), voided_reason: 'test' });
    expect(computeCoverageState(reg)).toBe('voided');
  });
});

describe('daysRemainingWarranty', () => {
  it('returns a positive number for a future coverage_end', () => {
    const future = new Date();
    future.setDate(future.getDate() + 30);
    const reg = makeReg({ coverage_end: future.toISOString().slice(0, 10) });
    expect(daysRemainingWarranty(reg)).toBeGreaterThan(0);
  });

  it('returns approximately 365 for a 1-year warranty starting today', () => {
    const future = new Date();
    future.setFullYear(future.getFullYear() + 1);
    const reg = makeReg({ coverage_end: future.toISOString().slice(0, 10) });
    const days = daysRemainingWarranty(reg);
    // Allow for leap-year and DST-edge variance (364–366 days)
    expect(days).toBeGreaterThanOrEqual(364);
    expect(days).toBeLessThanOrEqual(366);
  });
});
