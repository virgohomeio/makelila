// On-demand importer: Freightcom tracking-dashboard CSV export → public.shipments.
//
// Why this exists: the Freightcom API key is a sandbox key (the live host 401s on
// every route — see docs/freightcom-live-credentials.md), so sync-freightcom-
// shipments cannot reach the real account. This is the only path that puts
// current shipments on the Shipping dashboard until that is fixed. The 38 rows
// already there came from an export like this, loaded by an ad-hoc process that
// left no code behind; this is that process, made repeatable and tested.
//
// Parsing lives in scripts/lib/freightcom-csv.mjs and is covered by
// app/src/lib/freightcomCsv.test.ts under `npm test`. This file is just I/O.
//
// SAFETY: upserts on freightcom_shipment_id and never writes a null over a
// stored value — same rule the API sync follows, so importing cannot erase
// operator-entered data. raw_payload is merged, not replaced, preserving the
// provenance keys the dashboard derives Customer and Direction from.
//
// Usage:
//   node scripts/import-freightcom-tracking.mjs <export.csv> --dry-run
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//     node scripts/import-freightcom-tracking.mjs <export.csv>
//
// --dry-run parses and reports without writing, and is the right first move on
// any export whose schema we have not seen before.

import { readFileSync } from 'node:fs';
import { parseExport } from './lib/freightcom-csv.mjs';

const args    = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const file    = args.find(a => !a.startsWith('--'));

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!file) {
  console.error('Usage: node scripts/import-freightcom-tracking.mjs <export.csv> [--dry-run]');
  process.exit(1);
}
if (!DRY_RUN && (!SB_URL || !SB_KEY)) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, or pass --dry-run.');
  process.exit(1);
}

const { rows, headers, skipped, missing } = parseExport(readFileSync(file, 'utf8'));

console.log(`Parsed ${rows.length} shipment(s) from ${file}`);
console.log('Columns matched:', Object.keys(headers).join(', ') || '(none)');
if (skipped) console.log(`Skipped ${skipped} row(s) with no shipment id.`);

// Schema drift must be loud. Importing against an export whose key columns went
// unrecognised would fill the table with blanks that look like real records.
if (missing.length) {
  console.error(`\n✗ Could not find column(s) for: ${missing.join(', ')}`);
  console.error('  Headers seen:', JSON.stringify(Object.keys(headers)));
  console.error('  Add the export\'s spelling to FIELD_ALIASES in scripts/lib/freightcom-csv.mjs.');
  process.exit(1);
}
if (!rows.length) { console.log('Nothing to import.'); process.exit(0); }

const withCost = rows.filter(r => r.billed_amount !== undefined).length;
console.log(`${withCost} row(s) carry a cost` +
  (withCost === 0 ? ' — this export has no cost column, so Rate (CAD) stays as-is.' : '.'));

const sample = rows[0];
console.log('\nFirst row:', JSON.stringify(sample, null, 2));

if (DRY_RUN) { console.log('\n--dry-run: nothing written.'); process.exit(0); }

// ── Write ──────────────────────────────────────────────────────────────────

const rest = (path, init) => fetch(`${SB_URL}/rest/v1/${path}`, {
  ...init,
  headers: {
    apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`,
    'Content-Type': 'application/json', ...(init?.headers ?? {}),
  },
});

// Existing rows, so the import can merge rather than overwrite.
const ids = rows.map(r => r.freightcom_shipment_id);
const existing = new Map();
for (let i = 0; i < ids.length; i += 200) {
  const chunk = ids.slice(i, i + 200).map(encodeURIComponent).join(',');
  const res = await rest(`shipments?select=freightcom_shipment_id,raw_payload&freightcom_shipment_id=in.(${chunk})`);
  if (!res.ok) { console.error(`Read existing failed: ${res.status} ${await res.text()}`); process.exit(1); }
  for (const r of await res.json()) existing.set(String(r.freightcom_shipment_id), r.raw_payload ?? {});
}
console.log(`\n${existing.size} of ${rows.length} already exist — those will be updated in place.`);

// Provenance keys an existing row may hold that this export does not supply.
const PROVENANCE = ['direction', 'ship_to_name', 'ship_from_name', 'imported_from',
                    'transaction_no', 'dashboard_status', 'ref', 'delivered_on'];

const payload = rows.map(row => {
  const prev = existing.get(row.freightcom_shipment_id) ?? {};
  const merged = { ...row.raw_payload };
  for (const k of PROVENANCE) {
    if (merged[k] == null && prev[k] != null) merged[k] = prev[k];
  }
  // Drop empty values so a sparse export cannot blank a populated column.
  const out = { freightcom_shipment_id: row.freightcom_shipment_id, raw_payload: merged };
  for (const [k, v] of Object.entries(row)) {
    if (k === 'raw_payload' || k === 'freightcom_shipment_id') continue;
    if (v === null || v === undefined || v === '') continue;
    out[k] = v;
  }
  return out;
});

const toInsert = payload.filter(r => !existing.has(r.freightcom_shipment_id));
const toUpdate = payload.filter(r =>  existing.has(r.freightcom_shipment_id));

// Inserts and updates go by different routes on purpose.
//
// PostgREST's merge-duplicates upsert is an INSERT ... ON CONFLICT, and Postgres
// validates the proposed row before conflict resolution — so carrier and service
// (NOT NULL, no default) must be present even for a row that already exists.
// Sending them on an update would let a sparse export overwrite a populated
// carrier with an empty string, which is the precise failure this importer is
// meant to prevent. PATCH touches only the columns supplied, so updates use it
// and inserts keep the upsert path with the NOT NULL columns defaulted.
for (const r of toInsert) { r.carrier ??= ''; r.service ??= ''; }

let inserted = 0, updated = 0;

// PostgREST rejects a bulk insert whose objects have differing key sets ("All
// object keys must match"), and ours differ by design — a row with no delivery
// date omits delivered_at rather than sending null and erasing a stored one. So
// group by key signature and send one batch per shape. Padding every row to a
// common shape with nulls would reintroduce exactly that overwrite.
const groups = new Map();
for (const row of toInsert) {
  const sig = Object.keys(row).sort().join('|');
  if (!groups.has(sig)) groups.set(sig, []);
  groups.get(sig).push(row);
}
for (const batchRows of groups.values()) {
  for (let i = 0; i < batchRows.length; i += 100) {
    const batch = batchRows.slice(i, i + 100);
    const res = await rest('shipments', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify(batch),
    });
    if (!res.ok) { console.error(`\nInsert failed: ${res.status} ${await res.text()}`); process.exit(1); }
    inserted += batch.length;
    process.stdout.write(`\rInserted ${inserted}/${toInsert.length}`);
  }
}
if (toInsert.length) console.log('');

// One PATCH per existing row. Not batched, but these runs are tens to low
// hundreds of shipments and correctness beats a round-trip here.
for (const row of toUpdate) {
  const { freightcom_shipment_id: id, ...patch } = row;
  const res = await rest(
    `shipments?freightcom_shipment_id=eq.${encodeURIComponent(id)}`,
    { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(patch) },
  );
  if (!res.ok) { console.error(`\nUpdate ${id} failed: ${res.status} ${await res.text()}`); process.exit(1); }
  updated++;
  process.stdout.write(`\rUpdated ${updated}/${toUpdate.length}`);
}
if (toUpdate.length) console.log('');
const written = inserted + updated;

// Re-link serials and orders, exactly as the API sync does after a write.
for (const fn of ['match_shipment_serials', 'match_shipment_orders']) {
  const res = await rest(`rpc/${fn}`, { method: 'POST', body: '{}' });
  console.log(`${fn}: ${res.ok ? 'ok' : `FAILED ${res.status} ${await res.text()}`}`);
}

console.log(`\n✓ ${inserted} inserted, ${updated} updated (${written} total). Reload the Shipping dashboard.`);
