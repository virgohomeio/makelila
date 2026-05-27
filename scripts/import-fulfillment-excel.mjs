/**
 * One-shot importer for the LILA customer fulfillment Excel snapshot.
 *
 * Reconciles units.status against the Excel's shipping sheets. Only flips
 * units that are clearly mid-pipeline (ca-test, cn-test, team-test, ready,
 * reserved) to 'shipped' with customer_name / shipped_at / location / carrier
 * backfilled from the Excel row.
 *
 * Intentionally skips:
 *  - units already at status='shipped' (no-op)
 *  - units at status='rework' or 'scrap' (DB tracks current state; Excel
 *    shows historical shipment — leaving DB correct)
 *  - serials not in the units table (likely Excel typo or not yet IQC'd)
 *  - the orders and fulfillment_queue tables entirely
 *
 * Replacement, Return&Refund, and Return label sheets are not processed
 * here — those belong to the PostShipment flow.
 *
 * Usage (PowerShell):
 *   cd E:\Claude\makelila
 *   npm install --no-save xlsx @supabase/supabase-js   # if not already installed
 *   $env:SUPABASE_URL = "https://txeftbbzeflequvrmjjr.supabase.co"
 *   $env:SUPABASE_SERVICE_ROLE_KEY = "<service role key>"
 *   node scripts/import-fulfillment-excel.mjs --file "LILA customer fulfillment-20260526.xlsx" --dry-run
 *   node scripts/import-fulfillment-excel.mjs --file "LILA customer fulfillment-20260526.xlsx" --apply
 *
 * Idempotent: re-running with --apply on already-shipped serials is a no-op.
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';

const require = createRequire(import.meta.url);
const XLSX = require('xlsx');
const { createClient } = require('@supabase/supabase-js');

// ── CLI args ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const fileArgIdx = args.indexOf('--file');
const filePath = fileArgIdx >= 0 ? args[fileArgIdx + 1] : null;
const apply = args.includes('--apply');
const dryRun = !apply || args.includes('--dry-run');

if (!filePath) {
  console.error('Missing --file <path-to-xlsx>');
  process.exit(1);
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env');
  process.exit(1);
}

// ── Sheets to process and which column means what ────────────────────────────
const SHEETS = ['Canada Shipping', 'US Shipping', 'Personal Delivery'];
const SERIAL_RE = /^LL01-\d{11}$/;
// ca-test/cn-test/team-test = Build pipeline; ready/reserved = Fulfillment-ready
const ELIGIBLE_STATUSES = new Set(['ca-test', 'cn-test', 'team-test', 'ready', 'reserved']);
const SKIP_STATUSES = new Set(['rework', 'scrap']);

// Excel serial date → JS Date (Excel epoch 1900-01-00 with 1900 leap bug)
function excelDateToISO(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'string') {
    // Some rows have "[REPLACEMENT]" or other text — skip
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString();
  }
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  // Excel serial: days since 1899-12-30 (covers the 1900-bug correctly)
  const ms = (v - 25569) * 86400 * 1000;
  return new Date(ms).toISOString();
}

// Parse "16 Johnstone Ln, Charters Settlement, NB, E3C 0E3" → "Charters Settlement, NB"
function parseLocation(addr) {
  if (!addr || typeof addr !== 'string') return null;
  const parts = addr.split(',').map(s => s.trim()).filter(Boolean);
  // Usually [street, city, region, postal]; sometimes [street, city, region, postal, country]
  if (parts.length >= 3) return `${parts[parts.length - 3]}, ${parts[parts.length - 2].split(' ')[0]}`;
  if (parts.length === 2) return parts.join(', ');
  return addr.slice(0, 80);
}

function normalizeSerial(v) {
  if (v == null) return null;
  return String(v).trim().replace(/\s/g, '');
}

// ── Read Excel ───────────────────────────────────────────────────────────────
console.log(`Reading: ${filePath}`);
const wb = XLSX.readFile(filePath);
const excelRows = [];
for (const sheet of SHEETS) {
  if (!wb.SheetNames.includes(sheet)) {
    console.warn(`  Sheet not found: ${sheet}`);
    continue;
  }
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheet], { defval: null });
  for (const r of rows) {
    const serial = normalizeSerial(r['Serial Number']);
    if (!serial || !SERIAL_RE.test(serial)) continue;
    excelRows.push({
      sheet,
      serial,
      customer_name: r['Customer Name']?.toString().trim() || null,
      address: r['Address']?.toString().trim() || null,
      carrier: r['Carrier']?.toString().trim() || null,
      tracking_num: r['Tracking Number']?.toString().trim() || null,
      shipping_date: r['Shipping Date'] ?? r['Order Date'] ?? null,
    });
  }
}
// Dedup by serial — first occurrence wins (Canada → US → Personal Delivery order)
const bySerial = new Map();
for (const r of excelRows) {
  if (!bySerial.has(r.serial)) bySerial.set(r.serial, r);
}
console.log(`  Excel rows scanned: ${excelRows.length} (${bySerial.size} unique serials)`);

// ── Fetch current DB state ───────────────────────────────────────────────────
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const serialList = [...bySerial.keys()];
const { data: dbUnits, error: fetchErr } = await supabase
  .from('units')
  .select('serial, status, customer_name, shipped_at, location, carrier, tracking_num')
  .in('serial', serialList);
if (fetchErr) {
  console.error('Failed to fetch units:', fetchErr.message);
  process.exit(1);
}
const dbBySerial = new Map(dbUnits.map(u => [u.serial, u]));

// ── Classify ─────────────────────────────────────────────────────────────────
const buckets = {
  noop_already_shipped: [],
  flip_to_shipped:      [],
  skip_rework_or_scrap: [],
  skip_other_status:    [],
  not_in_db:            [],
};

for (const serial of serialList) {
  const excel = bySerial.get(serial);
  const db = dbBySerial.get(serial);
  if (!db) { buckets.not_in_db.push({ serial, excel }); continue; }
  if (db.status === 'shipped') { buckets.noop_already_shipped.push({ serial, db, excel }); continue; }
  if (SKIP_STATUSES.has(db.status)) { buckets.skip_rework_or_scrap.push({ serial, db, excel }); continue; }
  if (ELIGIBLE_STATUSES.has(db.status)) { buckets.flip_to_shipped.push({ serial, db, excel }); continue; }
  buckets.skip_other_status.push({ serial, db, excel });
}

// ── Report ───────────────────────────────────────────────────────────────────
console.log('\n── Classification ──');
console.log(`  No-op (already shipped):       ${buckets.noop_already_shipped.length}`);
console.log(`  WILL FLIP to shipped:          ${buckets.flip_to_shipped.length}`);
console.log(`  Skipped (rework/scrap):        ${buckets.skip_rework_or_scrap.length}`);
console.log(`  Skipped (other status):        ${buckets.skip_other_status.length}`);
console.log(`  Not in DB (investigate):       ${buckets.not_in_db.length}`);

if (buckets.skip_rework_or_scrap.length > 0) {
  console.log('\n  Rework/scrap (left alone — DB reflects current state):');
  for (const { serial, db } of buckets.skip_rework_or_scrap) {
    console.log(`    ${serial}  status=${db.status}  customer=${db.customer_name ?? '—'}`);
  }
}
if (buckets.skip_other_status.length > 0) {
  console.log('\n  Other status (investigate):');
  for (const { serial, db, excel } of buckets.skip_other_status) {
    console.log(`    ${serial}  status=${db.status}  excel-says=${excel.customer_name}`);
  }
}
if (buckets.not_in_db.length > 0) {
  console.log('\n  Not in DB:');
  for (const { serial, excel } of buckets.not_in_db) {
    console.log(`    ${serial}  excel=${excel.sheet}  customer=${excel.customer_name}`);
  }
}

// ── Apply ────────────────────────────────────────────────────────────────────
if (dryRun) {
  console.log('\n[dry-run] No writes performed. Re-run with --apply to update.');
  process.exit(0);
}

console.log('\n── Applying ──');
let updated = 0;
let failed = 0;
for (const { serial, db, excel } of buckets.flip_to_shipped) {
  // For shipping data, Excel is authoritative — but only when it has a value.
  // Two exceptions:
  //   1. customer_name keeps existing if present (e.g. legacy "Phil Parkinson (original)")
  //   2. location: Excel destination city overrides the inventory marker
  //      "MicroArt Warehouse" (which is where units sit pre-ship, not where shipped)
  const excelLoc = parseLocation(excel.address);
  const update = {
    status: 'shipped',
    customer_name: db.customer_name ?? excel.customer_name,
    location:      (db.location === 'MicroArt Warehouse' || !db.location) ? (excelLoc ?? db.location) : db.location,
    carrier:       excel.carrier   ?? db.carrier,
    tracking_num:  db.tracking_num ?? excel.tracking_num,
    shipped_at:    excelDateToISO(excel.shipping_date) ?? db.shipped_at,
  };
  const { error } = await supabase.from('units').update(update).eq('serial', serial);
  if (error) {
    console.error(`  FAIL ${serial}: ${error.message}`);
    failed++;
  } else {
    updated++;
  }
}
console.log(`\n  Updated: ${updated}`);
console.log(`  Failed:  ${failed}`);
