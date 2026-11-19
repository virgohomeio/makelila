// Tests for the sync-freightcom-shipments parsing helpers.
//
// The module lives with the edge function (Deno) but is deliberately free of
// Deno globals so it can be exercised here, under `npm test`, alongside the rest
// of the data layer. The alternative — a `deno test` file next to the function —
// isn't run by any current CI step or by any developer without Deno installed,
// which is how the original inline versions of these helpers shipped unverified.
import { describe, it, expect } from 'vitest';
import {
  money, splitCurrency, cadOnly, breakdown,
  pruneNulls, mergeRawPayload, mapStatus,
  documentNumber, pickCostDocument, docDate,
} from '../../../supabase/functions/sync-freightcom-shipments/parse';

describe('money', () => {
  it('reads the {value, currency} form as cents', () => {
    expect(money({ total: { value: '12345', currency: 'CAD' } }, 'total'))
      .toEqual({ amount: 123.45, currency: 'CAD' });
  });

  it('reads a bare number as dollars, not cents', () => {
    expect(money({ amount: 123.45 }, 'amount')).toEqual({ amount: 123.45, currency: null });
    expect(money({ amount: '123.45' }, 'amount')).toEqual({ amount: 123.45, currency: null });
  });

  it('picks up a sibling currency field on the bare-number form', () => {
    expect(money({ amount: '80.00', currency: 'usd' }, 'amount'))
      .toEqual({ amount: 80, currency: 'USD' });
  });

  it('tries keys in order and skips empty ones', () => {
    expect(money({ total: null, total_amount: { value: '500', currency: 'CAD' } },
                 'total', 'total_amount'))
      .toEqual({ amount: 5, currency: 'CAD' });
  });

  it('returns null for a missing or unparseable amount', () => {
    expect(money({}, 'total')).toBeNull();
    expect(money(null, 'total')).toBeNull();
    expect(money({ total: 'n/a' }, 'total')).toBeNull();
  });

  it('does not mistake a zero-cent invoice for a missing one', () => {
    expect(money({ total: { value: '0', currency: 'CAD' } }, 'total'))
      .toEqual({ amount: 0, currency: 'CAD' });
  });
});

describe('splitCurrency', () => {
  it('routes CAD into the cad column', () => {
    expect(splitCurrency({ amount: 42.5, currency: 'CAD' }))
      .toEqual({ cad: 42.5, amount: 42.5, currency: 'CAD' });
  });

  it('keeps a USD amount out of the cad column but does not lose it', () => {
    expect(splitCurrency({ amount: 80, currency: 'USD' }))
      .toEqual({ cad: null, amount: 80, currency: 'USD' });
  });

  it('treats an unlabelled amount as CAD', () => {
    expect(splitCurrency({ amount: 60, currency: null }))
      .toEqual({ cad: 60, amount: 60, currency: 'CAD' });
  });

  it('is all-null for a missing amount', () => {
    expect(splitCurrency(null)).toEqual({ cad: null, amount: null, currency: null });
  });
});

describe('cadOnly', () => {
  it('yields the amount for CAD and for an unlabelled amount', () => {
    expect(cadOnly({ amount: 42.5, currency: 'CAD' })).toBe(42.5);
    expect(cadOnly({ amount: 42.5, currency: null })).toBe(42.5);
  });

  it('refuses to report a non-CAD amount as CAD', () => {
    expect(cadOnly({ amount: 80, currency: 'USD' })).toBeNull();
    expect(cadOnly(null)).toBeNull();
  });
});

describe('breakdown', () => {
  it('buckets the named surcharges and collects the rest', () => {
    const b = breakdown([
      { name: 'Base Freight',        amount: { value: '5000', currency: 'CAD' } },
      { name: 'Fuel Surcharge',      amount: { value: '750',  currency: 'CAD' } },
      { name: 'Residential Address', amount: { value: '425',  currency: 'CAD' } },
      { name: 'Remote Area',         amount: { value: '300',  currency: 'CAD' } },
      { name: 'Signature Required',  amount: { value: '150',  currency: 'CAD' } },
    ]);
    expect(b.base_charge_cad).toBe(50);
    expect(b.fuel_surcharge_cad).toBe(7.5);
    expect(b.residential_surcharge_cad).toBe(4.25);
    expect(b.remote_surcharge_cad).toBe(3);
    expect(b.other_surcharges).toEqual([{ name: 'Signature Required', amount_cad: 1.5 }]);
  });

  it('accumulates repeated charges of the same kind instead of overwriting', () => {
    const b = breakdown([
      { name: 'Fuel Surcharge', amount: { value: '500', currency: 'CAD' } },
      { name: 'Fuel Surcharge', amount: { value: '250', currency: 'CAD' } },
    ]);
    expect(b.fuel_surcharge_cad).toBe(7.5);
  });

  it('excludes non-CAD lines from the CAD buckets', () => {
    const b = breakdown([
      { name: 'Base Freight', amount: { value: '5000', currency: 'USD' } },
      { name: 'Fuel',         amount: { value: '750',  currency: 'CAD' } },
    ]);
    expect(b.base_charge_cad).toBeNull();
    expect(b.fuel_surcharge_cad).toBe(7.5);
  });

  it('is all-null on an empty or absent charge list', () => {
    expect(breakdown([])).toEqual({
      base_charge_cad: null, fuel_surcharge_cad: null,
      residential_surcharge_cad: null, remote_surcharge_cad: null,
      other_surcharges: null,
    });
  });
});

describe('pruneNulls', () => {
  it('drops nulls so a partial response cannot erase stored values', () => {
    expect(pruneNulls({ carrier: 'UPS', service: null, billed_cad: 0, label_url: undefined }))
      .toEqual({ carrier: 'UPS', billed_cad: 0 });
  });

  it('keeps falsy-but-real values', () => {
    expect(pruneNulls({ billed_cad: 0, carrier: '' })).toEqual({ billed_cad: 0, carrier: '' });
  });
});

describe('mergeRawPayload', () => {
  const imported = {
    direction: 'return',
    ship_to_name: 'VCycene Inc.',
    ship_from_name: 'Brent Neave',
    imported_from: 'freightcom_tracking_dashboard',
    transaction_no: 44748249,
    dashboard_status: 'Ready for Shipping',
  };

  it('preserves the import provenance the dashboard derives Customer/Direction from', () => {
    const merged = mergeRawPayload(imported, { id: '44748249', state: 'in_transit' });
    expect(merged.direction).toBe('return');
    expect(merged.ship_from_name).toBe('Brent Neave');
    expect(merged.imported_from).toBe('freightcom_tracking_dashboard');
    expect(merged.state).toBe('in_transit');
  });

  it('lets the API payload win on keys that are not provenance', () => {
    const merged = mergeRawPayload({ ...imported, state: 'old' }, { state: 'delivered' });
    expect(merged.state).toBe('delivered');
  });

  it('works when there is nothing stored yet', () => {
    expect(mergeRawPayload(null, { id: 'x' })).toEqual({ id: 'x' });
    expect(mergeRawPayload(undefined, undefined)).toEqual({});
  });
});

describe('mapStatus', () => {
  it('maps the common Freightcom states', () => {
    expect(mapStatus('in-transit')).toBe('in_transit');
    expect(mapStatus('Delivered')).toBe('delivered');
    expect(mapStatus('cancelled')).toBe('cancelled');
    expect(mapStatus('waiting-for-transit')).toBe('in_transit');
    expect(mapStatus(null)).toBe('booked');
  });

  it('files a delivery exception as an exception, not a delivery', () => {
    expect(mapStatus('delivery exception')).toBe('exception');
  });

  it('only emits values the shipments.status check constraint allows', () => {
    const allowed = ['booked', 'in_transit', 'delivered', 'exception', 'missing', 'cancelled'];
    for (const s of ['in-transit', 'Delivered', 'lost in transit', 'error', 'weird', null]) {
      expect(allowed).toContain(mapStatus(s));
    }
  });
});

// ── Finance documents ──────────────────────────────────────────────────────
//
// Shapes below are copied verbatim from the live API (2026-08-11), not invented.
// The previous extractor looked for `shipment_id` and found 0 shipments across
// 774 real documents, which is what kept the Rate (CAD) column empty.

describe('documentNumber', () => {
  const live = {
    id: '028uK6URd6MJa7YXqpP8hjm2Y29HFFW7',
    type: 'shipment-order-details',
    number: '43694778',
    date: { year: 2026, month: 5, day: 14 },
    amount: { value: '19304', currency: 'CAD' },
  };

  it('reads `number` — the portal transaction number — from a live document', () => {
    expect(documentNumber(live)).toBe('43694778');
  });

  it('does not mistake the opaque document id for a shipment number', () => {
    expect(documentNumber(live)).not.toBe(live.id);
  });

  it('still honours the documented field names if the API ever sends them', () => {
    expect(documentNumber({ shipment_id: 'abc' })).toBe('abc');
    expect(documentNumber({ freight_shipment_id: 99 })).toBe('99');
  });

  it('returns null when no identifier is present', () => {
    expect(documentNumber({ type: 'x' })).toBeNull();
    expect(documentNumber(null)).toBeNull();
  });
});

describe('pickCostDocument', () => {
  const order  = { type: 'shipment-order-details', amount: { value: '22223', currency: 'CAD' } };
  const card   = { type: 'shipment-credit-card-invoice', amount: { value: '500', currency: 'CAD' } };
  const refund = { type: 'shipment-credit-card-refund-invoice', amount: { value: '22223', currency: 'CAD' } };

  it('prefers the shipment order details over a card invoice', () => {
    expect(pickCostDocument([card, order])).toBe(order);
  });

  it('never reports a refund as the cost of a shipment', () => {
    expect(pickCostDocument([refund])).toBeNull();
    expect(pickCostDocument([refund, order])).toBe(order);
  });

  it('falls back to whatever non-refund document exists', () => {
    expect(pickCostDocument([card])).toBe(card);
  });

  it('handles an empty group', () => {
    expect(pickCostDocument([])).toBeNull();
  });

  it('yields an amount in dollars once read through money()', () => {
    const pick = pickCostDocument([card, order])!;
    expect(money(pick, 'amount')).toEqual({ amount: 222.23, currency: 'CAD' });
  });
});

describe('docDate', () => {
  it('renders the {year, month, day} form zero-padded', () => {
    expect(docDate({ date: { year: 2026, month: 5, day: 4 } })).toBe('2026-05-04');
  });

  it('accepts an ISO string', () => {
    expect(docDate({ date: '2026-05-04T12:00:00Z' })).toBe('2026-05-04');
  });

  it('returns null on a partial or absent date', () => {
    expect(docDate({ date: { year: 2026 } })).toBeNull();
    expect(docDate({})).toBeNull();
    expect(docDate(null)).toBeNull();
  });
});
