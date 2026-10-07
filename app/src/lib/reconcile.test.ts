import { describe, it, expect } from 'vitest';
import { suggestForCustomer, type ReconcileOrderRow, type ReconcileUnitRow } from './reconcile';

function order(ref: string, placed: string, extra: Partial<ReconcileOrderRow> = {}): ReconcileOrderRow {
  return {
    id: `id-${ref}`, order_ref: ref, customer_id: 'cust-1', customer_name: 'Jane Doe',
    customer_email: 'jane@example.com', city: 'Toronto', region_state: 'ON', country: 'CA',
    total_usd: 999, currency: 'CAD', placed_at: placed, created_at: placed,
    ...extra,
  };
}

function unit(serial: string, shipped: string | null, extra: Partial<ReconcileUnitRow> = {}): ReconcileUnitRow {
  return {
    serial, customer_id: 'cust-1', customer_name: 'Jane Doe', shipped_at: shipped,
    customer_order_ref: null, carrier: 'Freightcom', tracking_num: 'TRK1',
    ...extra,
  };
}

describe('suggestForCustomer', () => {
  it('pairs a lone order with a lone unit shipped after it', () => {
    const s = suggestForCustomer([order('#1001', '2026-01-10')], [unit('LL01-1', '2026-01-20')]);
    expect(s.get('id-#1001')).toMatchObject({ kind: 'shipped', serial: 'LL01-1', confidence: 'high' });
  });

  it('trusts an explicit unit→order link over date proximity', () => {
    // The unit already names #1002, even though #1001 is the closer date.
    const orders = [order('#1001', '2026-01-10'), order('#1002', '2026-03-01')];
    const units = [unit('LL01-9', '2026-01-12', { customer_order_ref: '#1002' })];
    const s = suggestForCustomer(orders, units);
    expect(s.get('id-#1002')).toMatchObject({ kind: 'shipped', serial: 'LL01-9', confidence: 'high' });
    expect(s.get('id-#1001')?.kind).toBe('duplicate');
  });

  it('calls the surplus order a duplicate of the one that got the unit', () => {
    const orders = [order('#1016', '2025-12-13'), order('#1036', '2026-01-16')];
    const units = [unit('LL01-7', '2026-01-20')];
    const s = suggestForCustomer(orders, units);
    // The unit shipped four days after #1036 and five weeks after #1016.
    expect(s.get('id-#1036')).toMatchObject({ kind: 'shipped', serial: 'LL01-7' });
    expect(s.get('id-#1016')).toMatchObject({ kind: 'duplicate', ofOrderRef: '#1036' });
  });

  it('gives every order a unit when the counts match', () => {
    const orders = [order('#1', '2026-01-01'), order('#2', '2026-02-01')];
    const units = [unit('LL01-A', '2026-01-05'), unit('LL01-B', '2026-02-05')];
    const s = suggestForCustomer(orders, units);
    expect(s.get('id-#1')).toMatchObject({ kind: 'shipped', serial: 'LL01-A' });
    expect(s.get('id-#2')).toMatchObject({ kind: 'shipped', serial: 'LL01-B' });
  });

  it('drops confidence when the unit shipped before the order was placed', () => {
    const s = suggestForCustomer([order('#1001', '2026-06-01')], [unit('LL01-1', '2026-01-01')]);
    expect(s.get('id-#1001')).toMatchObject({ kind: 'shipped', confidence: 'low' });
  });

  it('drops confidence when the gap is longer than the window', () => {
    const s = suggestForCustomer([order('#1001', '2026-01-01')], [unit('LL01-1', '2026-09-01')]);
    expect(s.get('id-#1001')).toMatchObject({ kind: 'shipped', confidence: 'low' });
  });

  it('ignores a unit already claimed by an order outside this set', () => {
    const units = [unit('LL01-1', '2026-01-20', { customer_order_ref: '#0900' })];
    const s = suggestForCustomer([order('#1001', '2026-01-10')], units);
    expect(s.get('id-#1001')?.kind).toBe('none');
  });

  it('suggests nothing when the customer has no shipped unit', () => {
    const s = suggestForCustomer([order('#1001', '2026-01-10')], []);
    expect(s.get('id-#1001')?.kind).toBe('none');
  });

  it('falls back to created_at when placed_at is null', () => {
    const o = order('#1001', '2026-01-10');
    o.placed_at = null;
    const s = suggestForCustomer([o], [unit('LL01-1', '2026-01-20')]);
    expect(s.get('id-#1001')).toMatchObject({ kind: 'shipped', confidence: 'high' });
  });

  it('still pairs a unit that has no ship date, at low confidence', () => {
    const s = suggestForCustomer([order('#1001', '2026-01-10')], [unit('LL01-1', null)]);
    expect(s.get('id-#1001')).toMatchObject({ kind: 'shipped', serial: 'LL01-1', confidence: 'low' });
  });

  it('prefers a dated unit over an undated one', () => {
    const units = [unit('LL01-NODATE', null), unit('LL01-DATED', '2026-01-20')];
    const s = suggestForCustomer([order('#1001', '2026-01-10')], units);
    expect(s.get('id-#1001')).toMatchObject({ serial: 'LL01-DATED' });
  });
});
