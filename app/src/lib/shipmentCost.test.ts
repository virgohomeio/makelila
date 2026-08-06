// The Rate (CAD) column's meaning, pinned down.
//
// This column had been reading `rate_cad` — the quote captured at booking, only
// ever written for shipments makelila booked itself, and null on all 38 rows the
// dashboard actually shows. These tests fix what each cell is allowed to claim.
import { describe, it, expect } from 'vitest';
import {
  resolveShipmentCost, totalInvoicedCad, shipmentSelectVariants, isMissingColumnError,
} from './shipping';

describe('resolveShipmentCost', () => {
  it('prefers the invoiced CAD total over the booking quote', () => {
    expect(resolveShipmentCost({ billed_cad: 128.4, rate_cad: 99 }))
      .toEqual({ amount: 128.4, currency: 'CAD', basis: 'invoiced', foreign: false });
  });

  it('falls back to the quote, flagged as a quote', () => {
    expect(resolveShipmentCost({ billed_cad: null, rate_cad: 99 }))
      .toEqual({ amount: 99, currency: 'CAD', basis: 'quoted', foreign: false });
  });

  it('reports nothing rather than zero when neither is on file', () => {
    const c = resolveShipmentCost({ billed_cad: null, rate_cad: null });
    expect(c.basis).toBe('none');
    expect(c.amount).toBeNull();
  });

  it('shows a USD invoice as USD instead of dropping to a CAD quote', () => {
    expect(resolveShipmentCost({
      billed_cad: null, billed_amount: 80, billed_currency: 'USD', rate_cad: 110,
    })).toEqual({ amount: 80, currency: 'USD', basis: 'invoiced', foreign: true });
  });

  it('treats a zero-dollar invoice as a real cost, not a missing one', () => {
    const c = resolveShipmentCost({ billed_cad: 0, rate_cad: 99 });
    expect(c.basis).toBe('invoiced');
    expect(c.amount).toBe(0);
  });

  it('works on a row from a database without the currency columns', () => {
    expect(resolveShipmentCost({ billed_cad: 50, rate_cad: 60 }).amount).toBe(50);
  });
});

describe('totalInvoicedCad', () => {
  it('sums invoiced CAD only — quotes are estimates and must not enter a total', () => {
    const total = totalInvoicedCad([
      { billed_cad: 100.25, rate_cad: 90 },
      { billed_cad: 49.75,  rate_cad: null },
      { billed_cad: null,   rate_cad: 500 },                                   // quote
      { billed_cad: null,   billed_amount: 80, billed_currency: 'USD', rate_cad: null }, // USD
      { billed_cad: null,   rate_cad: null },                                  // nothing
    ]);
    expect(total).toBe(150);
  });

  it('is zero for an empty table', () => {
    expect(totalInvoicedCad([])).toBe(0);
  });
});

describe('shipmentSelectVariants', () => {
  it('offers progressively shorter column lists, fullest first', () => {
    const v = shipmentSelectVariants();
    expect(v.length).toBeGreaterThan(1);
    expect(v[0]).toContain('billed_amount');
    expect(v[0]).toContain('freightcom_status');
    // Last resort carries neither optional group but still selects the base.
    expect(v[v.length - 1]).not.toContain('billed_amount');
    expect(v[v.length - 1]).not.toContain('freightcom_status');
    expect(v[v.length - 1]).toContain('billed_cad');
  });

  it('always selects the breakdown columns the Rate hover text needs', () => {
    for (const cols of shipmentSelectVariants()) {
      expect(cols).toContain('fuel_surcharge_cad');
      expect(cols).toContain('invoice_number');
      expect(cols).toContain('orders(order_ref, customer_name)');
    }
  });
});

describe('isMissingColumnError', () => {
  it('recognises the 42703 that means the migration has not run', () => {
    expect(isMissingColumnError({ code: '42703' })).toBe(true);
    expect(isMissingColumnError({ message: 'column shipments.billed_currency does not exist' })).toBe(true);
    expect(isMissingColumnError({ code: '23505', message: 'duplicate key' })).toBe(false);
    expect(isMissingColumnError(null)).toBe(false);
  });
});
