import { describe, it, expect } from 'vitest';
import {
  SHIPPER_EMAIL,
  buildShipmentDetails,
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
