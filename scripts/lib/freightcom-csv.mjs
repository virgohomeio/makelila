// Parser for the Freightcom tracking-dashboard CSV export → public.shipments rows.
//
// Why this exists: the 38 shipments on the Shipping dashboard were loaded from
// exactly this kind of export by an ad-hoc process that left no code behind, so
// there has never been a repeatable way to refresh the dashboard. With the API
// blocked on a sandbox key, this is the only path that produces current data.
//
// Column detection is by header NAME, not position, because nobody has told us
// the export's exact schema and portal grids reorder columns when you toggle
// which ones are visible. Headers are normalised (lowercased, punctuation and
// spaces stripped) and matched against alias lists, so "Transaction No.",
// "transaction_no" and "Transaction Number" all resolve to the same field.
//
// Pure — no I/O, no Supabase, no Node built-ins — so it is unit-tested under
// `npm test` in app/.

// ── CSV ────────────────────────────────────────────────────────────────────

/**
 * RFC4180-ish CSV split. Handles quoted fields, escaped quotes (""), embedded
 * commas and newlines, and both CRLF and LF line endings.
 *
 * Hand-rolled rather than pulling a dependency: the existing importers in this
 * directory are deliberately dependency-free so they can be run with plain
 * `node` against a checkout.
 */
export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false, i = 0;

  // A BOM survives Excel round-trips and would corrupt the first header name.
  if (text.charCodeAt(0) === 0xfeff) i = 1;

  for (; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  // Drop trailing blank lines.
  return rows.filter(r => r.some(v => v.trim() !== ''));
}

// ── Header mapping ─────────────────────────────────────────────────────────

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Longest/most specific aliases first — "trackingnumber" must win over
// "number" style partial matches.
const FIELD_ALIASES = {
  shipment_id:  ['transactionno', 'transactionnumber', 'transactionid', 'transaction',
                 'shipmentid', 'shipmentno', 'shipmentnumber', 'id'],
  tracking:     ['primarytrackingnumber', 'trackingnumber', 'trackingno', 'tracking',
                 'waybill', 'waybillnumber', 'pronumber'],
  carrier:      ['carriername', 'carrier'],
  service:      ['servicename', 'servicelevel', 'service'],
  status:       ['shipmentstatus', 'trackingstatus', 'status', 'state'],
  ship_to:      ['shiptoname', 'consigneename', 'recipientname', 'shipto', 'consignee',
                 'recipient', 'deliverto', 'destinationname'],
  ship_from:    ['shipfromname', 'shippername', 'shipfrom', 'shipper', 'originname'],
  reference:    ['referenceno', 'referencenumber', 'reference', 'ref', 'ordernumber', 'orderref'],
  delivered_on: ['deliveredon', 'deliverydate', 'delivereddate', 'delivered'],
  booked_on:    ['createdon', 'createdate', 'shipdate', 'shippingdate', 'bookedon',
                 'datecreated', 'date'],
  cost:         ['invoicetotal', 'totalcharge', 'totalcost', 'totalamount', 'total',
                 'amount', 'charge', 'cost', 'price'],
  currency:     ['currency', 'currencycode'],
};

/**
 * Maps header cells to field names. Returns { field: columnIndex }.
 *
 * A header matches a field if its normalised form equals an alias or contains
 * one. Exact matches win over substring matches, and the first column to claim
 * a field keeps it — so a sheet with both "Total" and "Total Weight" resolves
 * "Total" to cost rather than whichever appeared last.
 */
export function mapHeaders(headerRow) {
  const cells = headerRow.map(norm);
  const out = {};
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    let exact = -1, partial = -1;
    for (let i = 0; i < cells.length; i++) {
      if (!cells[i] || Object.values(out).includes(i)) continue;
      if (aliases.includes(cells[i])) { exact = i; break; }
      if (partial === -1 && aliases.some(a => cells[i].includes(a))) partial = i;
    }
    const idx = exact !== -1 ? exact : partial;
    if (idx !== -1) out[field] = idx;
  }
  return out;
}

// ── Value coercion ─────────────────────────────────────────────────────────

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/** "Jun 23, 2026" | "2026-06-23" | "23/06/2026" → "2026-06-23", else null. */
export function toIsoDate(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;

  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;

  m = s.match(/^([A-Za-z]{3,})\s+(\d{1,2}),?\s*(\d{4})/);
  if (m) {
    const mo = MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (mo) return `${m[3]}-${String(mo).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  }

  // Ambiguous numeric form. Freightcom is Canadian and its portal renders
  // day-first, so DD/MM/YYYY is assumed; a value >12 in the first position
  // confirms it, and anything that would need MM/DD to be valid is rejected
  // rather than guessed.
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) {
    const d = +m[1], mo = +m[2];
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      return `${m[3]}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
  }
  return null;
}

/** "$1,234.56" | "1234.56 CAD" | "(12.00)" → number, else null. */
export function toAmount(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const negative = /^\(.*\)$/.test(s);
  const cleaned = s.replace(/[()]/g, '').replace(/[^0-9.\-]/g, '');
  if (cleaned === '' || cleaned === '-' || cleaned === '.') return null;
  const n = parseFloat(cleaned);
  if (Number.isNaN(n)) return null;
  return negative ? -n : n;
}

/** Currency named anywhere in the cell, e.g. "123.45 CAD" or "US$12". */
export function toCurrency(v, explicit) {
  const e = String(explicit ?? '').trim().toUpperCase();
  if (/^[A-Z]{3}$/.test(e)) return e;
  const s = String(v ?? '').toUpperCase();
  if (/\bCAD\b|^C\$|\bC\$/.test(s)) return 'CAD';
  if (/\bUSD\b|\bUS\$/.test(s)) return 'USD';
  return null;
}

// ── Status ─────────────────────────────────────────────────────────────────

// The portal's own labels, mapped to the two vocabularies the dashboard uses:
// `status` (the shipments check constraint) and `freightcom_status` (the raw
// vocabulary the filter chips match on).
const STATUS_MAP = [
  [/cancel/,                    'cancelled',  'cancelled'],
  [/exception|problem|failed/,  'exception',  'exception'],
  [/missing|lost/,              'missing',    'missing'],
  [/deliver/,                   'delivered',  'delivered'],
  [/transit|out for|picked up/, 'in_transit', 'in-transit'],
  [/ready|pending|await|book|label|created/, 'booked', 'waiting-for-transit'],
];

/** Portal label → { status, freightcom_status }. Unknown labels stay `booked`
 *  internally but keep their raw text, so they surface under the "Other" chip
 *  instead of being silently filed as something they are not. */
export function mapStatus(label) {
  const s = String(label ?? '').toLowerCase().trim();
  if (!s) return { status: 'booked', freightcom_status: null };
  for (const [re, status, fc] of STATUS_MAP) {
    if (re.test(s)) return { status, freightcom_status: fc };
  }
  return { status: 'booked', freightcom_status: s };
}

// ── Row → shipment ─────────────────────────────────────────────────────────

const OUR_NAMES = ['vcycene', 'lila'];
const isUs = (name) => OUR_NAMES.some(n => String(name ?? '').toLowerCase().includes(n));

/**
 * Direction of travel. Outbound when we are the sender; a return when we are
 * the recipient. Falls back to outbound when neither party is recognisably us,
 * which matches how the existing 38 rows were classified.
 */
export function deriveDirection(shipFrom, shipTo) {
  if (isUs(shipFrom)) return 'outbound';
  if (isUs(shipTo)) return 'return';
  return 'outbound';
}

/**
 * Builds one shipments row from a CSV record.
 *
 * Returns null when the row carries no shipment id — that column is the upsert
 * key, and a row without it cannot be reconciled against anything.
 *
 * Costs are only emitted when the export actually carries them. The tracking
 * grid does not, which is why the 38 existing rows have none; a billing export
 * would, and this handles both rather than assuming.
 */
export function rowToShipment(record, headers) {
  const at = (field) => {
    const i = headers[field];
    return i === undefined ? '' : String(record[i] ?? '').trim();
  };

  const shipmentId = at('shipment_id');
  if (!shipmentId) return null;

  const shipFrom = at('ship_from');
  const shipTo   = at('ship_to');
  const rawStatus = at('status');
  const { status, freightcom_status } = mapStatus(rawStatus);

  const amount   = headers.cost !== undefined ? toAmount(at('cost')) : null;
  const currency = amount === null ? null : (toCurrency(at('cost'), at('currency')) ?? 'CAD');

  const deliveredOn = toIsoDate(at('delivered_on'));
  const bookedOn    = toIsoDate(at('booked_on'));

  const row = {
    freightcom_shipment_id: shipmentId,
    carrier: at('carrier'),
    service: at('service'),
    status,
    primary_tracking_number: at('tracking') || null,
    // Provenance the dashboard derives Customer and Direction from. The marker
    // matches the existing rows so the sync's raw_payload merge keeps it.
    raw_payload: {
      imported_from: 'freightcom_tracking_dashboard',
      transaction_no: shipmentId,
      ship_to_name: shipTo || null,
      ship_from_name: shipFrom || null,
      direction: deriveDirection(shipFrom, shipTo),
      ref: at('reference') || null,
      delivered_on: at('delivered_on') || null,
      dashboard_status: rawStatus || null,
    },
  };

  if (freightcom_status) row.freightcom_status = freightcom_status;
  if (bookedOn)    row.booked_at = `${bookedOn}T00:00:00Z`;
  if (deliveredOn) row.delivered_at = `${deliveredOn}T00:00:00Z`;
  if (amount !== null) {
    row.billed_amount = amount;
    row.billed_currency = currency;
    // Same rule the API sync follows: the CAD column only ever holds CAD.
    if (currency === 'CAD') row.billed_cad = amount;
  }
  return row;
}

/**
 * Parses a whole export. Returns { rows, headers, skipped, missing }.
 *
 * `missing` names the fields no column matched, so a schema drift shows up as a
 * reported gap instead of a table quietly filling with nulls.
 */
export function parseExport(text) {
  const table = parseCsv(text);
  if (!table.length) return { rows: [], headers: {}, skipped: 0, missing: ['(empty file)'] };

  const headers = mapHeaders(table[0]);
  const rows = [];
  let skipped = 0;
  for (const rec of table.slice(1)) {
    const row = rowToShipment(rec, headers);
    if (row) rows.push(row); else skipped++;
  }

  const REQUIRED = ['shipment_id', 'status', 'ship_to', 'ship_from'];
  const missing = REQUIRED.filter(f => headers[f] === undefined);
  return { rows, headers, skipped, missing };
}
