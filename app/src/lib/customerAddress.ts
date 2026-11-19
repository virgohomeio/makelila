// "Where does this customer's machine ship to?"
//
// One definition, shared by the Customer Directory's list row, its detail panel
// and its CSV export — and, by construction, the same address Sales verifies on
// the order.
//
// The two copies, and why they drifted
// ------------------------------------
// The address an order ships to lives on `orders` (`address_line`,
// `address_line2`, `city`, `region_state`, `postal_code`, `country`), which is
// what Order Review shows, what Verify address checks against Google, and what
// goes on the freight label. `customers` carried a SECOND copy
// (`address_line`, `city`, `region`, `postal_code`, `country`) seeded from
// HubSpot's single concatenated `address` property and filled only while blank
// — see sync-hubspot-customers, which never clobbers an existing value. Nothing
// ever wrote an order's address back to it.
//
// So the two disagreed for 38 of the 206 customers who have an order. The worst
// class is the eleven orders with a second address line, because `customers`
// HAS NO SECOND LINE AT ALL: order #1272 ships to "901 Concession 14 Townsend"
// and the profile read "901" — a house number with no street. "16" and "629031"
// read the same way.
//
// Adding `address_line2` to `customers` and writing back on verify would fix
// today's eleven rows and re-open the same gap the next time an order address
// changes. So the directory now DERIVES the address from the customer's orders
// and keeps the `customers` columns only as the fallback for the 179 people who
// have no order (HubSpot contacts, warranty registrations). This is the same
// move as lib/heldUnits.ts, which derives held serials from `units` rather than
// trusting the stale `customers.serials` cache.

import { useEffect, useState } from 'react';
import { supabase } from './supabase';
import { orderPostalCode } from './orders';
import type { Customer } from './customers';
import type { AreaType, Dwelling, DwellingSource } from './addressClassify';

/** The order columns this module reads — every one of them also a field of
 *  `Order`, so an `Order[]` is accepted wherever this is. Nullable where the
 *  database is, which is looser than `Order` declares `city` and `country`;
 *  widening is safe in this direction and lets `exportPurchasers` select these
 *  columns alone instead of every order column. */
export interface AddressOrder {
  order_ref: string | null;
  customer_id: string | null;
  customer_email: string | null;
  address_line: string | null;
  address_line2: string | null;
  city: string | null;
  region_state: string | null;
  /** The postal code on the order, as synced. */
  postal_code: string | null;
  /** What the customer typed, and Google's standardized form of it. Both are
   *  fallbacks for `postal_code` — see orderPostalCode in lib/orders. */
  address_customer_postal: string | null;
  address_google_postal: string | null;
  /** The two claims Order Review makes about the address beyond the address
   *  itself: what kind of building it is, and whether the area is urban,
   *  suburban or rural. Each is only worth its `_source`, so both travel with
   *  one — a dwelling of 'house' from 'sync-guess' is a regex over the street
   *  line, not a fact. */
  address_verdict: Dwelling;
  address_verdict_source: DwellingSource;
  area_type: AreaType | null;
  area_type_source: string;
  address_area_type_error: string | null;
  country: string | null;
  placed_at: string | null;
  created_at: string | null;
  address_verified_at: string | null;
}

/** Select list for `AddressOrder`, kept next to the type so a column added to
 *  one is added to the other. */
export const ADDRESS_ORDER_COLUMNS =
  'order_ref, customer_id, customer_email, address_line, address_line2, city, '
  + 'region_state, postal_code, address_customer_postal, address_google_postal, '
  + 'country, placed_at, created_at, address_verified_at, '
  + 'address_verdict, address_verdict_source, area_type, area_type_source, '
  + 'address_area_type_error';

export type CustomerAddressSource = 'order' | 'directory';

export interface ResolvedCustomerAddress {
  line1: string | null;
  /** Apartment / unit / street continuation. Always null from the directory
   *  fallback — `customers` has no column for it. */
  line2: string | null;
  city: string | null;
  region: string | null;
  postal_code: string | null;
  country: string | null;
  source: CustomerAddressSource;
  /** The order this came from, for `source: 'order'`. */
  orderRef: string | null;
  /** When Sales last verified that order's address against Google. Null means
   *  nobody has run Verify address on it yet — the address is still the one we
   *  ship to, it just hasn't been checked. */
  verifiedAt: string | null;
  /** What kind of building, and how good the answer is. Null for a customer
   *  with no order: `customers` records none of this, and an absent claim must
   *  not be dressed up as an unconfirmed one. ALWAYS read `dwellingSource`
   *  alongside `dwelling`. */
  dwelling: Dwelling | null;
  dwellingSource: DwellingSource | null;
  /** Urban / suburban / rural, and where that came from. `areaType` is null
   *  both when nobody has classified it and when a classification failed;
   *  `areaTypeError` is what tells those apart. */
  areaType: AreaType | null;
  areaTypeSource: string | null;
  areaTypeError: string | null;
}

/** An order only describes a deliverable address if it has a street line. The
 *  INV- series carries a city and a postal code and no street, and letting one
 *  win would replace a complete directory address with an incomplete one. */
function hasStreet(o: AddressOrder): boolean {
  return !!o.address_line?.trim();
}

/** Newest first. Recency is the primary key because people move: the address on
 *  the most recent order is where the next machine goes, verified or not.
 *  `address_verified_at` only breaks a tie between orders placed the same
 *  moment (a split order, a same-day re-order). */
function betterThan(a: AddressOrder, b: AddressOrder): boolean {
  const at = a.placed_at ?? a.created_at ?? '';
  const bt = b.placed_at ?? b.created_at ?? '';
  if (at !== bt) return at > bt;
  if (!!a.address_verified_at !== !!b.address_verified_at) return !!a.address_verified_at;
  return (a.order_ref ?? '') > (b.order_ref ?? '');
}

export type CustomerAddressIndex = {
  byId: Map<string, AddressOrder>;
  byEmail: Map<string, AddressOrder>;
};

/**
 * Pre-pick the best-addressed order per customer, so a directory of hundreds of
 * rows doesn't re-scan every order per row.
 *
 * Keyed by FK and, for the orders that have no FK, by lowercased email. As in
 * lib/heldUnits, the email bucket is a fallback and not a peer: an order that
 * HAS a `customer_id` is indexed by that alone, so a shared or mistyped email
 * can't pull one customer's address onto another's profile.
 */
export function buildCustomerAddressIndex(orders: AddressOrder[]): CustomerAddressIndex {
  const byId = new Map<string, AddressOrder>();
  const byEmail = new Map<string, AddressOrder>();
  for (const o of orders) {
    if (!hasStreet(o)) continue;
    if (o.customer_id) {
      const cur = byId.get(o.customer_id);
      if (!cur || betterThan(o, cur)) byId.set(o.customer_id, o);
      continue;
    }
    const key = o.customer_email?.toLowerCase().trim();
    if (!key) continue;
    const cur = byEmail.get(key);
    if (!cur || betterThan(o, cur)) byEmail.set(key, o);
  }
  return { byId, byEmail };
}

type AddressCustomer = Pick<
  Customer, 'id' | 'email' | 'address_line' | 'city' | 'region' | 'postal_code' | 'country'
>;

/** The address to show for a customer: their latest order's, else the record. */
export function resolveCustomerAddress(
  customer: AddressCustomer,
  index: CustomerAddressIndex,
): ResolvedCustomerAddress {
  const email = customer.email?.toLowerCase().trim();
  const o = index.byId.get(customer.id) ?? (email ? index.byEmail.get(email) : undefined);
  if (o) {
    return {
      line1: o.address_line,
      line2: o.address_line2,
      city: o.city,
      region: o.region_state,
      postal_code: orderPostalCode(o),
      country: o.country,
      source: 'order',
      orderRef: o.order_ref,
      verifiedAt: o.address_verified_at,
      dwelling: o.address_verdict,
      dwellingSource: o.address_verdict_source,
      areaType: o.area_type,
      areaTypeSource: o.area_type_source,
      areaTypeError: o.address_area_type_error,
    };
  }
  return {
    line1: customer.address_line,
    line2: null,
    city: customer.city,
    region: customer.region,
    postal_code: customer.postal_code,
    country: customer.country,
    source: 'directory',
    orderRef: null,
    verifiedAt: null,
    dwelling: null,
    dwellingSource: null,
    areaType: null,
    areaTypeSource: null,
    areaTypeError: null,
  };
}

/** Street line as one string: the second line is an apartment or a street
 *  continuation, never a standalone fact. */
export function streetOf(a: ResolvedCustomerAddress): string | null {
  return [a.line1, a.line2].filter(Boolean).join(' ') || null;
}

/** Do we know where this person is? A city alone counts — same rule as the
 *  directory's "No address" chip, which has always counted city / region /
 *  postal rather than requiring a street. */
export function hasResolvedAddress(a: ResolvedCustomerAddress): boolean {
  return !!(a.line1 || a.city || a.region || a.postal_code);
}

function cityRegionOf(a: ResolvedCustomerAddress): string {
  return [a.city, a.region].filter(Boolean).join(', ');
}

/** One line, for a table cell. Internal whitespace is collapsed because a few
 *  imported orders have a newline inside `address_line`, which a single-line
 *  cell would render as a torn row. */
export function formatAddressLine(a: ResolvedCustomerAddress): string {
  return [streetOf(a), cityRegionOf(a), a.postal_code, a.country]
    .filter(Boolean).join(' · ').replace(/\s+/g, ' ');
}

/** A shipping block, for the detail panel: an operator checking an address
 *  against a label is comparing lines, not scanning a sentence. */
export function formatAddressBlock(a: ResolvedCustomerAddress): string {
  return [
    streetOf(a),
    cityRegionOf(a),
    [a.postal_code, a.country].filter(Boolean).join('  '),
  ].filter(Boolean).join('\n');
}

/**
 * Every order's address, indexed for the directory.
 *
 * Deliberately NOT `useOrders()`. That hook's `all` bucket is the Sales queue —
 * "every sale Order Review still shows", which excludes fulfilled and cancelled
 * orders and starts after SALES_QUEUE_START. Most customers' orders shipped
 * long ago, so reading it left them falling back to the `customers` snapshot:
 * the very rows this module exists to fix (#1034, #1168) still showed a bare
 * house number. The directory wants every order that ever had an address.
 *
 * Fetched once on mount with no realtime subscription. An address changes when
 * an operator edits it in Sales, on another screen, and the directory picks
 * that up the next time it loads — which is worth more than a third realtime
 * channel and the stale-socket failure mode that comes with one.
 */
export function useCustomerAddressIndex(): { index: CustomerAddressIndex; loading: boolean } {
  const [index, setIndex] = useState<CustomerAddressIndex>(() => buildCustomerAddressIndex([]));
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase.from('orders').select(ADDRESS_ORDER_COLUMNS);
      if (cancelled) return;
      if (!error && data) setIndex(buildCustomerAddressIndex(data as unknown as AddressOrder[]));
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  return { index, loading };
}
