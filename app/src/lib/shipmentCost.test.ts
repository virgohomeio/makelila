// The Rate (CAD) column's meaning, pinned down.
//
// This column had been reading `rate_cad` — the quote captured at booking, only
// ever written for shipments makelila booked itself, and null on all 38 rows the
// dashboard actually shows. These tests fix what each cell is allowed to claim.
import { describe, it, expect } from 'vitest';
import {
  resolveShipmentCost, totalActualCad, isActualCost,
  shipmentSelectVariants, isMissingColumnError,
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

  it('prefers a recorded actual cost over a quote', () => {
    expect(resolveShipmentCost({ billed_cad: null, recorded_cost: 143.08, recorded_currency: 'CAD', rate_cad: 99 }))
      .toEqual({ amount: 143.08, currency: 'CAD', basis: 'recorded', foreign: false });
  });

  it('still prefers a Freightcom invoice over a recorded cost', () => {
    expect(resolveShipmentCost({ billed_cad: 128.4, recorded_cost: 143.08, recorded_currency: 'CAD', rate_cad: 99 }).basis)
      .toBe('invoiced');
  });

  it('reads the recorded currency instead of trusting the _usd column name', () => {
    // orders.shipping_cost_usd holds CAD; the suffix is a lie the UI must not repeat.
    const c = resolveShipmentCost({ billed_cad: null, recorded_cost: 60, recorded_currency: 'CAD', rate_cad: null });
    expect(c.currency).toBe('CAD');
    expect(c.foreign).toBe(false);

    const usd = resolveShipmentCost({ billed_cad: null, recorded_cost: 60, recorded_currency: 'USD', rate_cad: null });
    expect(usd.foreign).toBe(true);
    expect(usd.currency).toBe('USD');
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

describe('isActualCost', () => {
  it('counts money spent, not estimates', () => {
    expect(isActualCost('invoiced')).toBe(true);
    expect(isActualCost('recorded')).toBe(true);
    expect(isActualCost('quoted')).toBe(false);
    expect(isActualCost('none')).toBe(false);
  });
});

describe('totalActualCad', () => {
  it('sums invoiced and recorded CAD — quotes are estimates and must not enter a total', () => {
    const total = totalActualCad([
      { billed_cad: 100.25, rate_cad: 90 },
      { billed_cad: 49.75,  rate_cad: null },
      { billed_cad: null, recorded_cost: 50, recorded_currency: 'CAD', rate_cad: null },
      { billed_cad: null,   rate_cad: 500 },                                   // quote
      { billed_cad: null,   billed_amount: 80, billed_currency: 'USD', rate_cad: null }, // USD
      { billed_cad: null, recorded_cost: 70, recorded_currency: 'USD', rate_cad: null }, // USD
      { billed_cad: null,   rate_cad: null },                                  // nothing
    ]);
    expect(total).toBe(200);
  });

  it('never sums across currencies at an implied rate of 1.0', () => {
    expect(totalActualCad([
      { billed_cad: null, recorded_cost: 100, recorded_currency: 'USD', rate_cad: null },
    ])).toBe(0);
  });

  it('is zero for an empty table', () => {
    expect(totalActualCad([])).toBe(0);
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
      expect(cols).toContain('orders(order_ref, customer_name');
    }
  });

  it('degrades the orders join too, so a missing shipping_cost_currency still renders', () => {
    const v = shipmentSelectVariants();
    expect(v[0]).toContain('shipping_cost_currency');
    // The final fallback asks for nothing that a later migration added.
    const last = v[v.length - 1];
    expect(last).not.toContain('shipping_cost_currency');
    expect(last).not.toContain('billed_amount');
    expect(last).toContain('orders(order_ref, customer_name)');
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
