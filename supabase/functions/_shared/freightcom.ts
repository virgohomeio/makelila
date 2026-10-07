// Shared Freightcom request builder.
//
// `freightcom-quote`, `freightcom-book` and `book-return-label` each POST the
// same `details` object — to /rate, to /shipment, and to both in turn. All three
// hand-rolled it, so all three carried the same defect: a CA→US shipment is an
// *international* one to Freightcom, and international rating is refused without
// an email address at each end. Measured against the live API on 2026-08-13:
//
//   POST /rate  {origin: {address}, destination: {address}}   → 400
//     data: { "details.origin.email_addresses":
//             "at least one email address is required for international shipments" }
//   …with origin.email_addresses added                        → 400
//     data: { "details.destination.email_addresses": same complaint }
//   …with both                                                → 202, 8–10 rates, CAD
//
// So every US order failed at the first Freightcom call and the operator saw
// only "Freightcom rate request failed", while Canadian orders quoted fine.
// Nothing else in the body has to change for cross-border: no street address, no
// customs block.
//
// The emails are emitted unconditionally rather than only when the countries
// differ. Domestic CA→CA rating is unaffected by them (measured: 22 rates with
// and without), and one code path cannot drift out of sync with the other.
//
// Deno-free on purpose: `app/src/lib/freightcomRequest.test.ts` imports this
// module directly, which is the only way the request shape gets tested at all —
// the edge functions themselves run untested against the live API.

/** Where Freightcom sends shipper-side notices and customs correspondence, and
 *  the fallback whenever an order has no customer email on file. */
export const SHIPPER_EMAIL = 'support@lilacomposter.com';

export type FreightcomCountry = 'CA' | 'US';

export type FreightcomPackage = {
  weight_kg: number;
  length_cm: number;
  width_cm: number;
  height_cm: number;
  description?: string;
};

export type ShipDate = { year: number; month: number; day: number };

/** One end of a shipment as our tables hold it: a postal code, a country, and
 *  possibly a contact email. */
export type EndpointInput = {
  postal_code: string;
  country: string;
  email?: string | null;
};

export type FreightcomLocation = {
  address: { postal_code: string; country: FreightcomCountry };
  email_addresses: string[];
  signature_requirement?: 'not-required';
};

export type ShipmentDetails = {
  expected_ship_date: ShipDate;
  packaging_type: 'package';
  packaging_properties: {
    packages: Array<{
      measurements: {
        weight: { unit: 'kg'; value: number };
        cuboid: { unit: 'cm'; l: number; w: number; h: number };
      };
      description: string;
    }>;
  };
  origin: FreightcomLocation;
  destination: FreightcomLocation;
};

/** We ship to two countries; anything else in the column is a data problem, not
 *  a destination, and 'CA' is the safer read of it than passing it through. */
function normalizeCountry(country: string): FreightcomCountry {
  return country === 'US' ? 'US' : 'CA';
}

/** Freightcom rejects postal codes containing spaces ("M1N 1H9"). */
function normalizePostal(postal: string): string {
  return postal.replace(/\s/g, '');
}

function location(input: EndpointInput): FreightcomLocation {
  const email = input.email?.trim();
  return {
    address: {
      postal_code: normalizePostal(input.postal_code),
      country: normalizeCountry(input.country),
    },
    email_addresses: [email || SHIPPER_EMAIL],
  };
}

/** Build the `details` block shared by POST /rate and POST /shipment. */
export function buildShipmentDetails(input: {
  origin: EndpointInput;
  destination: EndpointInput;
  packages: FreightcomPackage[];
  shipDate: ShipDate;
}): ShipmentDetails {
  return {
    expected_ship_date: input.shipDate,
    packaging_type: 'package',
    packaging_properties: {
      packages: input.packages.map((p) => ({
        measurements: {
          weight: { unit: 'kg', value: p.weight_kg },
          cuboid: { unit: 'cm', l: p.length_cm, w: p.width_cm, h: p.height_cm },
        },
        description: p.description ?? 'LILA Composter',
      })),
    },
    origin: location(input.origin),
    destination: { ...location(input.destination), signature_requirement: 'not-required' },
  };
}

/** The LILA composter as it ships: one 23 kg box, 61 cm on every side. Every
 *  caller rated exactly one of these no matter what the order said, which is
 *  the whole of the multi-unit defect below. */
export const LILA_PACKAGE: FreightcomPackage = {
  weight_kg: 23, length_cm: 61, width_cm: 61, height_cm: 61, description: 'LILA Composter',
};

/** A line item as the orders table holds one. Shopify-synced sale lines carry
 *  no `kind`; replacement lines do. */
export type QuotableLineItem = {
  kind?: string;
  name?: string;
  qty?: number;
  price_usd?: number;
};

/** Cart lines that are not a thing in a box: a discount unlock, a gift card, a
 *  tip. They carry a qty of 1 like everything else, so without this an order
 *  with a promo line would be rated as two composters. Matched from the start
 *  of the name, not on a loose "off"/"sale" substring — "LILA Composter
 *  (Pre-order 20% OFF)" is a real unit and must not be dropped. */
const NON_SHIPPABLE_LINE =
  /^(?:unlock\b|gift\s*card|e-?gift|discount\b|donation\b|tip\b|warranty\b|protection\s+plan\b|installation\b|shipping\s+protection\b)/i;

/** How many composter boxes this order actually puts on a truck.
 *
 *  Freight scales with the box count and nothing else: measured against the
 *  live API on 2026-09-10, L3R9Z7 → M1N 1H9 rates $36.43 CAD for one package
 *  and $59.98 for two. `freightcom-quote` rated a single package for every
 *  order regardless, so a two-unit order was quoted at roughly 60% of its real
 *  cost. Parts are excluded — a replacement part is not a 23 kg pallet box, and
 *  rating it as one overstates the freight rather than understating it. */
export function shippableUnitCount(items: QuotableLineItem[] | null | undefined): number {
  let n = 0;
  for (const li of items ?? []) {
    if (li?.kind === 'part') continue;
    if (NON_SHIPPABLE_LINE.test((li?.name ?? '').trim())) continue;
    const qty = Number(li?.qty);
    n += Number.isFinite(qty) && qty > 0 ? Math.floor(qty) : 1;
  }
  return n;
}

/** The package list to rate for an order. Always at least one box: an order
 *  whose lines we cannot read still needs a number an operator can work with,
 *  and a zero-package body is rejected by Freightcom outright. */
export function packagesForLineItems(items: QuotableLineItem[] | null | undefined): FreightcomPackage[] {
  const n = Math.max(1, shippableUnitCount(items));
  return Array.from({ length: n }, () => ({ ...LILA_PACKAGE }));
}

/** Which postal code to rate against.
 *
 *  A rate is only as accurate as the destination it was asked about, and the
 *  destination we hold can be wrong: address verification exists precisely
 *  because customers mistype their postal code. When it has established that
 *  the customer's code is wrong AND has the postal authority's own code, that
 *  is the one to quote — otherwise Sales prices an order against a place the
 *  parcel will never go.
 *
 *  Anything short of a confirmed mismatch keeps the customer's code: an
 *  unverified or unverifiable address is not evidence of anything. */
export function quotableDestinationPostal(order: {
  postal_code?: string | null;
  country?: string | null;
  address_match?: string | null;
  address_google_postal?: string | null;
}): { postal_code: string | null; source: 'customer' | 'verified' } {
  const country = order.country === 'US' ? 'US' : 'CA';
  const customer = rateablePostal(order.postal_code, country);
  const verified = rateablePostal(order.address_google_postal, country);
  if (order.address_match === 'mismatch' && verified) {
    return { postal_code: verified, source: 'verified' };
  }
  return { postal_code: customer, source: 'customer' };
}

/** A postal code in the form Freightcom rates on. Google hands back ZIP+4
 *  ("42320-2143") and customers type spaces; neither is what the carrier wants,
 *  and a US +4 is more precision than any rate engine uses. */
export function rateablePostal(
  postal: string | null | undefined, country: string,
): string | null {
  const raw = (postal ?? '').toUpperCase().replace(/[\s-]/g, '');
  if (!raw) return null;
  if (country === 'US') {
    const m = raw.match(/^(\d{5})\d{0,4}$/);
    return m ? m[1] : null;
  }
  return raw;
}

/** Tomorrow, UTC — the default expected ship date every caller uses. */
export function nextShipDate(now: number): ShipDate {
  const d = new Date(now + 86_400_000);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}
