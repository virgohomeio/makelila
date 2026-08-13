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

/** Tomorrow, UTC — the default expected ship date every caller uses. */
export function nextShipDate(now: number): ShipDate {
  const d = new Date(now + 86_400_000);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}
