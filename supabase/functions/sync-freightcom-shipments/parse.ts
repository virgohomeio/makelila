// Pure helpers for sync-freightcom-shipments.
//
// Split out of index.ts so the money handling and the merge rules can be tested
// without a Freightcom account or a Deno runtime — both were previously inline
// and both were wrong in ways that only showed up as bad numbers on a dashboard.

export type FCDoc = Record<string, unknown>;

// ── Money ──────────────────────────────────────────────────────────────────

/** A Freightcom amount, normalised. `amount` is in major units (dollars). */
export type Money = { amount: number; currency: string | null };

/**
 * Freightcom returns money two ways:
 *   { value: "12345", currency: "CAD" }   — value is an integer number of CENTS
 *   12345.67 / "12345.67"                 — already in dollars, currency implicit
 *
 * The cents form is the one the API uses everywhere freightcom-quote touches it
 * (see freightcom-quote/index.ts, which reads exactly this pair). The bare-number
 * form shows up on some finance documents. Distinguishing them matters: treating
 * a cents value as dollars overstates a shipment 100×, and the reverse divides a
 * real cost into pennies.
 */
export function money(obj: FCDoc | null, ...keys: string[]): Money | null {
  if (!obj) return null;
  for (const k of keys) {
    const v = obj[k];
    if (v === null || v === undefined || v === '') continue;

    if (typeof v === 'object') {
      const o = v as FCDoc;
      if (o.value === undefined || o.value === null) continue;
      const cents = parseInt(String(o.value), 10);
      if (Number.isNaN(cents)) continue;
      return {
        amount: cents / 100,
        currency: typeof o.currency === 'string' ? o.currency.toUpperCase() : null,
      };
    }

    const parsed = parseFloat(String(v));
    if (!Number.isNaN(parsed)) {
      const cur = obj.currency ?? obj.currency_code ?? obj.currencyCode;
      return { amount: parsed, currency: typeof cur === 'string' ? cur.toUpperCase() : null };
    }
  }
  return null;
}

/**
 * Splits a Money into the three columns the dashboard reads.
 *
 * `cad` is populated only when the currency is genuinely CAD (or absent — every
 * VCycene shipment invoiced to date has been Canadian, so an unlabelled amount
 * is treated as CAD rather than thrown away). Anything explicitly non-CAD keeps
 * its native amount and label and leaves `cad` null, so the "Rate (CAD)" column
 * never shows a US figure with a Canadian heading.
 */
export function splitCurrency(m: Money | null): {
  cad: number | null; amount: number | null; currency: string | null;
} {
  if (!m) return { cad: null, amount: null, currency: null };
  const currency = m.currency ?? 'CAD';
  return { cad: currency === 'CAD' ? m.amount : null, amount: m.amount, currency };
}

/** CAD component of an amount, or null if it was billed in something else. */
export function cadOnly(m: Money | null): number | null {
  return splitCurrency(m).cad;
}

// ── Charge breakdown ───────────────────────────────────────────────────────

export type ChargeBreakdown = {
  base_charge_cad: number | null;
  fuel_surcharge_cad: number | null;
  residential_surcharge_cad: number | null;
  remote_surcharge_cad: number | null;
  other_surcharges: { name: string; amount_cad: number }[] | null;
};

/**
 * Buckets an invoice's line charges into the named surcharge columns.
 *
 * Two behaviours worth stating because the previous version had neither:
 * repeated charges of the same kind ACCUMULATE rather than the last one winning
 * (Freightcom splits fuel across multiple lines on multi-package shipments), and
 * non-CAD lines are dropped from the *_cad buckets instead of being added to
 * them as though the currencies were interchangeable.
 */
export function breakdown(charges: FCDoc[]): ChargeBreakdown {
  let base: number | null = null, fuel: number | null = null;
  let resi: number | null = null, remote: number | null = null;
  const other: { name: string; amount_cad: number }[] = [];

  const add = (cur: number | null, v: number) => (cur ?? 0) + v;

  for (const charge of charges ?? []) {
    const nameRaw = charge['name'] ?? charge['description'] ?? charge['type'];
    const name = typeof nameRaw === 'string' ? nameRaw : '';
    const amt = cadOnly(money(charge, 'amount', 'value', 'total'));
    if (amt === null) continue; // unparseable, or billed in a non-CAD currency

    const nl = name.toLowerCase();
    if (nl.includes('base') || nl.includes('freight')) base = add(base, amt);
    else if (nl.includes('fuel')) fuel = add(fuel, amt);
    else if (nl.includes('residential') || nl.includes('resi')) resi = add(resi, amt);
    else if (nl.includes('remote') || nl.includes('rural')) remote = add(remote, amt);
    else other.push({ name, amount_cad: amt });
  }

  return {
    base_charge_cad: base, fuel_surcharge_cad: fuel,
    residential_surcharge_cad: resi, remote_surcharge_cad: remote,
    other_surcharges: other.length ? other : null,
  };
}

// ── Finance documents ──────────────────────────────────────────────────────

/**
 * The transaction number a finance document belongs to.
 *
 * Measured against the live API on 2026-08-11. A document looks like:
 *
 *   { id: "028uK6URd6MJa7YXqpP8hjm2Y29HFFW7",
 *     type: "shipment-order-details", number: "43694778",
 *     date: {...}, amount: { value: "19304", currency: "CAD" }, owing: {...} }
 *
 * `number` is the portal's transaction number — the same identifier stored in
 * shipments.freightcom_shipment_id by the tracking-dashboard CSV import. `id` is
 * an opaque document key that resolves nowhere else. The previous extractor
 * looked only for `shipment_id`/`shipmentId`/`freight_shipment_id` and nested
 * line items, none of which this API returns, so it found 0 shipments in 774
 * documents and the sync had nothing to reconcile.
 */
export function documentNumber(doc: FCDoc | null): string | null {
  if (!doc) return null;
  for (const k of ['number', 'shipment_id', 'shipmentId', 'freight_shipment_id']) {
    const v = doc[k];
    if (typeof v === 'string' && v) return v;
    if (typeof v === 'number') return String(v);
  }
  return null;
}

/** Document types that represent money moving back to us, not the cost of the
 *  shipment. Netting these into the shipment cost would understate it. */
const REFUND_TYPES = ['refund'];

/** Preference order for "what did this shipment cost". `shipment-order-details`
 *  is the charge breakdown for the shipment itself; the credit-card invoices are
 *  payment records that may bundle several shipments. */
const COST_TYPE_RANK = [
  'shipment-order-details',
  'shipment-credit-card-detailed-invoice',
  'shipment-credit-card-invoice',
];

/**
 * Chooses the authoritative cost document for one transaction number.
 *
 * Freightcom returns several documents per shipment — on this account 774
 * documents across 359 numbers. Picking arbitrarily (as "first one wins" would)
 * risks reading a refund or a bundled card invoice as the shipment's cost.
 */
export function pickCostDocument(docs: FCDoc[]): FCDoc | null {
  const usable = (docs ?? []).filter((d) => {
    const t = String(d['type'] ?? '').toLowerCase();
    return !REFUND_TYPES.some((r) => t.includes(r));
  });
  if (!usable.length) return null;
  for (const type of COST_TYPE_RANK) {
    const hit = usable.find((d) => String(d['type'] ?? '').toLowerCase() === type);
    if (hit) return hit;
  }
  return usable[0];
}

/** Freightcom dates arrive as {year, month, day}; render as YYYY-MM-DD. */
export function docDate(doc: FCDoc | null): string | null {
  const d = doc?.['date'] ?? doc?.['document_date'] ?? doc?.['invoice_date'];
  if (!d) return null;
  if (typeof d === 'string') return d.slice(0, 10);
  const { year, month, day } = d as { year?: number; month?: number; day?: number };
  if (!year || !month || !day) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// ── Merge rules ────────────────────────────────────────────────────────────

/**
 * Drops keys whose value is null/undefined.
 *
 * The sync builds a full row per shipment and upserts it. Any field the API
 * didn't return came through as null and overwrote whatever was already in the
 * column — so a partial API response could erase a tracking number or a carrier
 * that an operator had entered by hand. A sync should add what it knows and
 * leave the rest alone.
 */
export function pruneNulls<T extends Record<string, unknown>>(row: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v !== null && v !== undefined) out[k] = v;
  }
  return out as Partial<T>;
}

/** Provenance written by the hand-loaded tracking-dashboard import. */
const IMPORT_KEYS = [
  'direction', 'ship_to_name', 'ship_from_name',
  'imported_from', 'transaction_no', 'dashboard_status', 'ref', 'delivered_on',
] as const;

/**
 * Merges the API's shipment payload over the stored one, preserving the import
 * provenance keys.
 *
 * All 38 rows on the dashboard carry a hand-loaded raw_payload, and the Customer
 * and Direction columns are derived from it (`deriveShipmentParty` in
 * lib/shipping.ts reads direction / ship_to_name / ship_from_name). Replacing
 * raw_payload wholesale with the Freightcom shipment object — which is what the
 * previous version did — would blank both columns for every existing row the
 * moment a live sync succeeded.
 */
export function mergeRawPayload(
  existing: FCDoc | null | undefined, incoming: FCDoc | null | undefined,
): FCDoc {
  const merged: FCDoc = { ...(incoming ?? {}) };
  const prev = existing ?? {};
  for (const k of IMPORT_KEYS) {
    if (prev[k] !== undefined && merged[k] === undefined) merged[k] = prev[k];
  }
  // Keep the import marker even if the API payload happens to define the key.
  if (prev['imported_from'] !== undefined) merged['imported_from'] = prev['imported_from'];
  return merged;
}

// ── Status ─────────────────────────────────────────────────────────────────

/**
 * Maps Freightcom's state vocabulary onto the shipments.status check constraint.
 *
 * Order matters: the fault states are tested before the happy ones because
 * Freightcom phrases several of them as qualified successes — "delivery
 * exception" contains "deliver", and matching that first would file a failed
 * delivery under Delivered.
 */
export function mapStatus(state: string | null): string {
  if (!state) return 'booked';
  const s = state.toLowerCase();
  if (s.includes('cancel')) return 'cancelled';
  if (s.includes('exception') || s.includes('error')) return 'exception';
  if (s.includes('missing') || s.includes('lost')) return 'missing';
  if (s.includes('deliver')) return 'delivered';
  if (s.includes('transit')) return 'in_transit';
  return 'booked';
}
