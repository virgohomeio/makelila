import { describe, it, expect } from 'vitest';
import {
  SHIPPER_EMAIL,
  buildShipmentDetails,
  packagesForLineItems,
  quotableDestinationPostal,
  shippableUnitCount,
} from '../../../supabase/functions/_shared/freightcom.ts';

// Freight quoting worked for Canadian orders and failed for every American one,
// with the opaque "Freightcom rate request failed" the 502 branch produces.
// Measured against the live API on 2026-08-13, POST /rate answers a CA→US
// request that carries only postal codes with:
//
//   400 {"message":"bad or missing data","data":{
//         "details.origin.email_addresses":
//           "at least one email address is required for international shipments"}}
//
// and, once the origin has one, the same complaint about
// `details.destination.email_addresses`. With both present the same request
// returns 202 and 8–10 CAD-priced rates. Nothing else about the body needs to
// change — no street address, no customs block. Domestic CA→CA rating is
// unaffected by the extra fields (measured: 22 rates before and after), so the
// builder always emits them rather than branching on the destination country.
//
// These cases pin that shape down. The builder is shared by freightcom-quote,
// freightcom-book and book-return-label, all three of which hand-rolled the
// identical `details` object and so carried the identical bug.

const PACKAGES = [
  { weight_kg: 23, length_cm: 61, width_cm: 61, height_cm: 61, description: 'LILA Composter' },
];
const SHIP_DATE = { year: 2026, month: 8, day: 14 };

function details(dest: { postal_code: string; country: string; email?: string | null }) {
  return buildShipmentDetails({
    origin: { postal_code: 'L3R9Z7', country: 'CA' },
    destination: dest,
    packages: PACKAGES,
    shipDate: SHIP_DATE,
  });
}

describe('buildShipmentDetails', () => {
  it('gives a US destination an email address on both ends', () => {
    const d = details({ postal_code: '01772', country: 'US', email: 'buyer@example.com' });

    expect(d.origin.email_addresses).toEqual([SHIPPER_EMAIL]);
    expect(d.destination.email_addresses).toEqual(['buyer@example.com']);
  });

  it('falls back to the shipper address when the order has no customer email', () => {
    // One live US order has no customer_email. Without a fallback that order
    // would keep failing exactly as before the fix.
    for (const email of [null, undefined, '', '   ']) {
      const d = details({ postal_code: '98277', country: 'US', email });
      expect(d.destination.email_addresses, `email=${JSON.stringify(email)}`)
        .toEqual([SHIPPER_EMAIL]);
    }
  });

  it('emits the emails for domestic shipments too', () => {
    const d = details({ postal_code: 'M1N 1H9', country: 'CA', email: 'buyer@example.com' });

    expect(d.origin.email_addresses).toEqual([SHIPPER_EMAIL]);
    expect(d.destination.email_addresses).toEqual(['buyer@example.com']);
  });

  it('keeps the request shape the API already accepts', () => {
    const d = details({ postal_code: 'M1N 1H9', country: 'CA' });

    expect(d.expected_ship_date).toEqual(SHIP_DATE);
    expect(d.packaging_type).toBe('package');
    // Postal codes go up without spaces — Freightcom rejects "M1N 1H9".
    expect(d.destination.address).toEqual({ postal_code: 'M1N1H9', country: 'CA' });
    expect(d.origin.address).toEqual({ postal_code: 'L3R9Z7', country: 'CA' });
    expect(d.destination.signature_requirement).toBe('not-required');
    expect(d.packaging_properties).toEqual({
      packages: [{
        measurements: {
          weight: { unit: 'kg', value: 23 },
          cuboid: { unit: 'cm', l: 61, w: 61, h: 61 },
        },
        description: 'LILA Composter',
      }],
    });
  });

  it('treats any country that is not US as CA', () => {
    // Callers pass orders.country straight through; the API only ever sees the
    // two countries we ship to.
    expect(details({ postal_code: '01772', country: 'us' }).destination.address.country).toBe('CA');
    expect(details({ postal_code: '01772', country: 'US' }).destination.address.country).toBe('US');
    expect(details({ postal_code: 'M1N1H9', country: '' }).destination.address.country).toBe('CA');
  });
});

// ── How many boxes, and to which postal code ────────────────────────────
//
// Both of these decide whether a rate is an estimate of THIS order's freight or
// of something else. Measured against the live API on 2026-09-10 (origin
// L3R9Z7 → M1N 1H9, 23 kg 61³ boxes):
//
//   1 package  → $36.43 CAD (Canpar Ground)
//   2 packages → $59.98 CAD
//
// freightcom-quote rated exactly one package for every order regardless of what
// the order carried, so a two-unit order was quoted at ~60% of its real cost.
describe('shippableUnitCount', () => {
  it('counts a single-unit Shopify sale as one box', () => {
    expect(shippableUnitCount([{ name: 'LILA Pro', qty: 1, price_usd: 849.99 }])).toBe(1);
  });

  it('follows qty — the two-unit order that used to be quoted as one', () => {
    expect(shippableUnitCount([{ name: 'LILA Pro', qty: 2, price_usd: 1699.98 }])).toBe(2);
  });

  it('adds up separate lines', () => {
    expect(shippableUnitCount([
      { name: 'LILA Composter', qty: 1 },
      { name: 'LILA Composter (Pre-order 20% OFF)', qty: 2 },
    ])).toBe(3);
  });

  // A promo line carries qty 1 like everything else. Live example: order with
  // "Unlock 30% Off in Cart" alongside the composter.
  it('ignores a cart line that is not a thing in a box', () => {
    expect(shippableUnitCount([
      { name: 'LILA Pro', qty: 1 },
      { name: 'Unlock 30% Off in Cart', qty: 1 },
    ])).toBe(1);
  });

  // "…20% OFF" is a real composter. A looser rule on the word "off" would drop
  // it and quote the order at zero boxes.
  it('keeps a discounted composter, whose name also says OFF', () => {
    expect(shippableUnitCount([{ name: 'LILA Composter (Pre-order 20% OFF)', qty: 1 }])).toBe(1);
  });

  it('skips parts — a replacement part is not a 23 kg pallet box', () => {
    expect(shippableUnitCount([
      { kind: 'part', name: 'Auger motor', qty: 2 },
      { kind: 'unit', name: 'LILA Pro', qty: 1 },
    ])).toBe(1);
  });

  it('treats an unreadable qty as one box rather than none', () => {
    expect(shippableUnitCount([{ name: 'LILA Pro' }])).toBe(1);
    expect(shippableUnitCount([{ name: 'LILA Pro', qty: 0 }])).toBe(1);
  });
});

describe('packagesForLineItems', () => {
  it('emits one composter-sized package per unit', () => {
    const pkgs = packagesForLineItems([{ name: 'LILA Pro', qty: 2 }]);
    expect(pkgs).toHaveLength(2);
    expect(pkgs[0]).toEqual({
      weight_kg: 23, length_cm: 61, width_cm: 61, height_cm: 61, description: 'LILA Composter',
    });
  });

  // Freightcom rejects a zero-package body outright, and an operator still
  // needs a number from an order whose lines we cannot read.
  it('never returns an empty package list', () => {
    expect(packagesForLineItems([])).toHaveLength(1);
    expect(packagesForLineItems(null)).toHaveLength(1);
    expect(packagesForLineItems([{ name: 'Unlock 30% Off in Cart', qty: 1 }])).toHaveLength(1);
  });
});

describe('quotableDestinationPostal', () => {
  it('quotes the customer’s own code when nothing says it is wrong', () => {
    expect(quotableDestinationPostal({ postal_code: 'M1N 1H9', country: 'CA' }))
      .toEqual({ postal_code: 'M1N1H9', source: 'customer' });
  });

  // The whole reason address verification runs first: a rate against the wrong
  // postal code is a confident number about a place the parcel will never go.
  it('quotes the postal authority’s code once a mismatch is established', () => {
    expect(quotableDestinationPostal({
      postal_code: 'M1N 1H8', country: 'CA',
      address_match: 'mismatch', address_google_postal: 'M1N 1H9',
    })).toEqual({ postal_code: 'M1N1H9', source: 'verified' });
  });

  it('keeps the customer’s code when the address could not be verified', () => {
    expect(quotableDestinationPostal({
      postal_code: '17901', country: 'US',
      address_match: 'unverifiable', address_google_postal: null,
    })).toEqual({ postal_code: '17901', source: 'customer' });
  });

  // Google answers US addresses with ZIP+4 ("17901-8740"); carriers rate on the
  // five-digit code.
  it('trims a ZIP+4 back to five digits', () => {
    expect(quotableDestinationPostal({
      postal_code: '17902', country: 'US',
      address_match: 'mismatch', address_google_postal: '17901-8740',
    })).toEqual({ postal_code: '17901', source: 'verified' });
  });

  it('reports no postal code rather than a malformed one', () => {
    expect(quotableDestinationPostal({ postal_code: 'not a zip', country: 'US' }).postal_code).toBeNull();
    expect(quotableDestinationPostal({ postal_code: null, country: 'CA' }).postal_code).toBeNull();
  });
});
