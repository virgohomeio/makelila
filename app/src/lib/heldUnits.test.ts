import { describe, it, expect } from 'vitest';
import {
  isHeld,
  buildHeldSerialIndex,
  serialsForCustomer,
  heldUnitsForCustomer,
} from './heldUnits';
import type { Unit } from './stock';

function unit(p: Partial<Unit> & Pick<Unit, 'serial'>): Unit {
  return {
    batch: 'LL01', status: 'shipped', color: null, location: null,
    customer_name: null, customer_id: null, customer_order_ref: null,
    carrier: null, firmware_version: null, defect_reason: null, tracking_num: null,
    shipped_at: null, notes: null, status_updated_at: '2026-09-01T00:00:00Z',
    status_updated_by: null, created_at: '2026-04-01T00:00:00Z',
    technician: null, electrical_check: null, mechanical_check: null,
    defect_notes: null, electrical_failed_tests: null, test_report_path: null,
    test_report_name: null, test_report_uploaded_at: null,
    is_team_test: false, backfilled_at: null, backfill_source: null,
    ...p,
  } as Unit;
}

const ELLERY = { id: 'ellery', full_name: 'Ellery Bunn' };

describe('isHeld', () => {
  it('counts only shipped units as held', () => {
    expect(isHeld(unit({ serial: 'a', status: 'shipped' }))).toBe(true);
    for (const status of ['rework', 'scrap', 'ready', 'team-test'] as const) {
      expect(isHeld(unit({ serial: 'a', status }))).toBe(false);
    }
  });
});

describe('serialsForCustomer', () => {
  it('returns FK-linked held units', () => {
    const idx = buildHeldSerialIndex([
      unit({ serial: 'LL01-100', customer_id: 'ellery' }),
      unit({ serial: 'LL01-101', customer_id: 'someone-else' }),
    ]);
    expect(serialsForCustomer(ELLERY, idx)).toEqual(['LL01-100']);
  });

  it('does not list a unit the customer has sent back', () => {
    // Ellery Bunn's LL01-…150 sits in rework. Before the shipped-only filter
    // the directory kept showing it as held after the replacement went out.
    const idx = buildHeldSerialIndex([
      unit({ serial: 'LL01-150', customer_id: 'ellery', status: 'rework' }),
    ]);
    expect(serialsForCustomer(ELLERY, idx)).toEqual([]);
  });

  it('unions FK and name matches rather than short-circuiting', () => {
    // The Kevin Cheng case: one unit mis-linked by FK, another carrying only
    // his name. `byId ?? byName` dropped the second entirely.
    const kevin = { id: 'kevin', full_name: 'Kevin Cheng' };
    const idx = buildHeldSerialIndex([
      unit({ serial: 'LL01-341', customer_id: 'kevin' }),
      unit({ serial: 'LL01-039', customer_name: 'Kevin Cheng' }),
    ]);
    expect(serialsForCustomer(kevin, idx).sort()).toEqual(['LL01-039', 'LL01-341']);
  });

  it('does not double-count a unit matching by both FK and name', () => {
    const idx = buildHeldSerialIndex([
      unit({ serial: 'LL01-100', customer_id: 'ellery', customer_name: 'Ellery Bunn' }),
    ]);
    expect(serialsForCustomer(ELLERY, idx)).toEqual(['LL01-100']);
  });

  it('never pulls an FK-linked unit under a second customer by name', () => {
    // LL01-…310 is named "Amanda Acker" in Stock but FK-linked elsewhere.
    // Amanda must not see it via the name bucket while that link stands.
    const amanda = { id: 'amanda', full_name: 'Amanda Acker' };
    const idx = buildHeldSerialIndex([
      unit({ serial: 'LL01-310', customer_id: 'joseph', customer_name: 'Amanda Acker' }),
    ]);
    expect(serialsForCustomer(amanda, idx)).toEqual([]);
  });

  it('returns empty for a customer with no units, ignoring any stale cache', () => {
    // Amanda McCordic's only serial lived in customers.serials, and Stock has
    // since scrapped it. The directory must show nothing, not a phantom.
    const idx = buildHeldSerialIndex([
      unit({ serial: 'LL01-145', customer_id: 'mccordic', status: 'scrap' }),
    ]);
    expect(serialsForCustomer({ id: 'mccordic', full_name: 'Amanda McCordic' }, idx)).toEqual([]);
  });
});

describe('heldUnitsForCustomer', () => {
  it('agrees with serialsForCustomer on the same data', () => {
    // The row and the panel disagreeing is the bug this shared module exists to
    // prevent, so assert they stay in step.
    const units = [
      unit({ serial: 'LL01-100', customer_id: 'ellery' }),
      unit({ serial: 'LL01-150', customer_id: 'ellery', status: 'rework' }),
      unit({ serial: 'LL01-200', customer_name: 'Ellery Bunn' }),
    ];
    const fromPanel = heldUnitsForCustomer(ELLERY, units).map(u => u.serial).sort();
    const fromRow = serialsForCustomer(ELLERY, buildHeldSerialIndex(units)).sort();
    expect(fromPanel).toEqual(fromRow);
    expect(fromRow).toEqual(['LL01-100', 'LL01-200']);
  });
});
