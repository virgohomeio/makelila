// On-demand importer: "LILA customer fulfillment.xlsx" (Google Drive) → public.fulfillment_log.
//
// Reads the .xlsx via the make-lila-bot service account (Drive alt=media, no
// npm deps — unzip via zlib, JWT via crypto), maps the 4 shipping tabs with
// explicit per-tab COLUMN POSITION maps (the sheet's header labels are
// unreliable/drifted), normalizes Excel serial dates + prices, and UPSERTs on
// (source_tab, source_row) so re-runs refresh in place.
//
// Two write modes:
//   * REST upsert  — if SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are set.
//   * SQL emit     — otherwise, writes scripts/out/fulfillment_log.sql (apply by hand / via MCP).
// Add --dry-run to parse + report counts without writing anything.
//
// Usage:
//   GSA_KEY_PATH=.secrets/lila-bot.json SHEET_ID=<id> \
//   [SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=...] \
//   node scripts/import-fulfillment-sheet.mjs [--dry-run]

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createSign } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

const KEY_PATH = process.env.GSA_KEY_PATH || '.secrets/lila-bot.json';
const SHEET_ID = process.env.SHEET_ID;
const DRY_RUN = process.argv.includes('--dry-run');
// Compact bootstrap: emit only the identity columns (tab,row,name,email,serial)
// so the serial→customer sync can run before a full service-role load exists.
const EMIT_BOOTSTRAP = process.argv.includes('--emit-bootstrap');
const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SHEET_ID) { console.error('Set SHEET_ID'); process.exit(1); }
const sa = JSON.parse(readFileSync(KEY_PATH, 'utf8'));

// ----- Per-tab column maps (0-indexed by POSITION, not header label) ----------
// kind: 'date' = Excel serial → ISO date; 'price' = numeric; else text.
const TABS = {
  'Canada Shipping': [
    [0, 'shipping_date', 'date'], [1, 'customer_name'], [2, 'order_date', 'date'],
    [3, 'address'], [4, 'phone'], [5, 'email'], [6, 'batch'], [7, 'color'],
    [8, 'serial_number'], [9, 'tracking_number'], [10, 'carrier'], [11, 'price', 'price'],
    [12, 'update_status'], [13, 'replacement_batch'], [14, 'notes'],
  ],
  'US Shipping': [
    [0, 'shipping_date', 'date'], [1, 'customer_name'], [2, 'order_date', 'date'],
    [3, 'address'], [4, 'phone'], [5, 'email'], [6, 'batch'], [7, 'color'],
    [8, 'serial_number'], [9, 'tracking_number'], [10, 'carrier'], [11, 'price', 'price'],
    [12, 'update_status'], [13, 'starter_ordered', 'date'], [14, 'amazon_tracking_id'],
    [15, 'starter_delivery'], [16, 'notes'],
  ],
  'Replacement': [
    [0, 'shipping_date', 'date'], [1, 'customer_name'], [2, 'ticket_date', 'date'],
    [3, 'address'], [4, 'phone'], [5, 'email'], [6, 'batch'], [7, 'color'],
    [8, 'serial_number'], [9, 'tracking_number'], [10, 'carrier'], [11, 'price', 'price'],
    [12, 'update_status'], [13, 'notes'],
  ],
  'Personal Delivery': [
    [0, 'delivery_window'], [1, 'customer_name'], [2, 'order_date', 'date'],
    [3, 'address'], [4, 'phone'], [5, 'email'], [6, 'batch'], [7, 'serial_number'],
    [8, 'update_status'],
  ],
};

// All DB columns (order matters for SQL/REST payloads).
const COLUMNS = [
  'source_tab', 'source_row', 'shipping_date', 'order_date', 'ticket_date',
  'delivery_window', 'customer_name', 'address', 'phone', 'email', 'batch',
  'color', 'serial_number', 'tracking_number', 'carrier', 'price',
  'update_status', 'replacement_batch', 'starter_ordered', 'amazon_tracking_id',
  'starter_delivery', 'notes', 'raw',
];
const DATE_COLS = new Set(['shipping_date', 'order_date', 'ticket_date', 'starter_ordered']);
const NUM_COLS = new Set(['price', 'source_row']);

// ----- Google auth (service account JWT → OAuth access token) ------------------
function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function getAccessToken(scope) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({ iss: sa.client_email, scope, aud: sa.token_uri, iat: now, exp: now + 3600 }));
  const input = `${header}.${claims}`;
  const sig = b64url(createSign('RSA-SHA256').update(input).sign(sa.private_key));
  const res = await fetch(sa.token_uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${input}.${sig}` }),
  });
  const json = await res.json();
  if (!res.ok || !json.access_token) throw new Error(`token ${res.status}: ${JSON.stringify(json)}`);
  return json.access_token;
}

// ----- XLSX parsing (zip via zlib + XML) --------------------------------------
function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a zip');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const files = {};
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + compSize);
    files[name] = method === 0 ? raw : inflateRawSync(raw);
    off += 46 + nameLen + extraLen + commLen;
  }
  return files;
}
const decodeXml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).replace(/&amp;/g, '&');
const colIndex = (ref) => { let n = 0; for (const ch of ref.match(/^[A-Z]+/)[0]) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };

function readWorkbook(buf) {
  const files = unzip(buf);
  const dec = (n) => files[n] ? files[n].toString('utf8') : '';
  const shared = [];
  for (const si of dec('xl/sharedStrings.xml').match(/<si>[\s\S]*?<\/si>/g) || []) {
    const parts = si.match(/<t[^>]*>([\s\S]*?)<\/t>/g) || [];
    shared.push(parts.map((t) => decodeXml(t.replace(/<[^>]+>/g, ''))).join(''));
  }
  const relsXml = dec('xl/_rels/workbook.xml.rels');
  const relMap = {};
  for (const r of relsXml.match(/<Relationship[^>]*>/g) || []) {
    const id = (r.match(/Id="([^"]+)"/) || [])[1];
    const tgt = (r.match(/Target="([^"]+)"/) || [])[1];
    if (id && tgt) relMap[id] = `xl/${tgt.replace(/^\/?xl\//, '').replace(/^\//, '')}`;
  }
  const sheets = {};
  for (const s of dec('xl/workbook.xml').match(/<sheet[^>]*\/?>/g) || []) {
    const name = decodeXml((s.match(/name="([^"]*)"/) || [])[1] || '');
    const rid = (s.match(/r:id="([^"]+)"/) || [])[1];
    sheets[name] = relMap[rid];
  }
  const readSheet = (path) => {
    const xml = dec(path);
    const out = [];
    for (const rowXml of xml.match(/<row[\s\S]*?<\/row>/g) || []) {
      const rowNum = +((rowXml.match(/<row[^>]*\br="(\d+)"/) || [])[1] || out.length + 1);
      const cells = [];
      for (const cm of rowXml.match(/<c[^>]*>[\s\S]*?<\/c>|<c[^>]*\/>/g) || []) {
        const ref = (cm.match(/r="([A-Z]+)\d+"/) || [])[1];
        const type = (cm.match(/t="([^"]+)"/) || [])[1];
        const idx = ref ? colIndex(ref + '1') : cells.length;
        let val = '';
        if (type === 's') { const v = (cm.match(/<v>([\s\S]*?)<\/v>/) || [])[1]; val = v !== undefined ? (shared[+v] ?? '') : ''; }
        else if (type === 'inlineStr') { const t = cm.match(/<t[^>]*>([\s\S]*?)<\/t>/); val = t ? decodeXml(t[1]) : ''; }
        else { const v = (cm.match(/<v>([\s\S]*?)<\/v>/) || [])[1]; val = v !== undefined ? decodeXml(v) : ''; }
        cells[idx] = String(val).replace(/\s+$/g, '').trim();
      }
      for (let i = 0; i < cells.length; i++) if (cells[i] === undefined) cells[i] = '';
      out.push({ rowNum, cells });
    }
    return out;
  };
  return { sheets, readSheet };
}

// ----- Normalizers ------------------------------------------------------------
const EXCEL_EPOCH = Date.UTC(1899, 11, 30);
function toDate(cell) {
  const m = String(cell).match(/^(\d{4,6})(?:\.0+)?$/);
  if (!m) return null;
  const serial = +m[1];
  if (serial < 30000 || serial > 60000) return null; // ~1982..2064 sanity window
  return new Date(EXCEL_EPOCH + serial * 86400000).toISOString().slice(0, 10);
}
function toPrice(cell) {
  const n = parseFloat(String(cell).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n.toFixed(2) : null;
}

// ----- Build rows -------------------------------------------------------------
function buildRows(wb) {
  const rows = [];
  const report = {};
  for (const [tab, map] of Object.entries(TABS)) {
    const path = wb.sheets[tab];
    if (!path) { console.error(`WARN: tab not found: ${tab}`); continue; }
    let kept = 0, skipped = 0, headerSkipped = 0;
    for (const { rowNum, cells } of wb.readSheet(path)) {
      if (rowNum === 1) { headerSkipped++; continue; } // header row
      const rec = Object.fromEntries(COLUMNS.map((c) => [c, null]));
      rec.source_tab = tab;
      rec.source_row = rowNum;
      rec.raw = cells;
      for (const [idx, field, kind] of map) {
        const cell = cells[idx] ?? '';
        if (cell === '') continue;
        rec[field] = kind === 'date' ? toDate(cell) : kind === 'price' ? toPrice(cell) : cell;
      }
      // Skip blank rows (no identifying data).
      const hasData = rec.customer_name || rec.serial_number || rec.email || rec.tracking_number || rec.address;
      if (!hasData) { skipped++; continue; }
      rows.push(rec);
      kept++;
    }
    report[tab] = { kept, skipped, headerSkipped };
  }
  return { rows, report };
}

// ----- Writers ----------------------------------------------------------------
const sqlLit = (col, v) => {
  if (v === null || v === undefined || v === '') return 'NULL';
  if (col === 'raw') return `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
  if (NUM_COLS.has(col)) return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
};
function emitSql(rows) {
  mkdirSync('scripts/out', { recursive: true });
  const setCols = COLUMNS.filter((c) => c !== 'source_tab' && c !== 'source_row');
  const onConflict = `on conflict (source_tab, source_row) do update set ` +
    setCols.map((c) => `${c} = excluded.${c}`).join(', ') + `, imported_at = now()`;
  const chunks = [];
  for (let i = 0; i < rows.length; i += 200) chunks.push(rows.slice(i, i + 200));
  const stmts = chunks.map((chunk) =>
    `insert into public.fulfillment_log (${COLUMNS.join(', ')}) values\n` +
    chunk.map((r) => '  (' + COLUMNS.map((c) => sqlLit(c, r[c])).join(', ') + ')').join(',\n') +
    `\n${onConflict};`);
  const path = 'scripts/out/fulfillment_log.sql';
  writeFileSync(path, stmts.join('\n\n') + '\n');
  return path;
}
async function restUpsert(rows) {
  const payload = rows.map((r) => Object.fromEntries(COLUMNS.map((c) => [c, r[c] === '' ? null : r[c]])));
  let done = 0;
  for (let i = 0; i < payload.length; i += 500) {
    const batch = payload.slice(i, i + 500);
    const res = await fetch(`${SB_URL}/rest/v1/fulfillment_log?on_conflict=source_tab,source_row`, {
      method: 'POST',
      headers: {
        apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`,
        'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(batch),
    });
    if (!res.ok) throw new Error(`REST ${res.status}: ${(await res.text()).slice(0, 400)}`);
    done += batch.length;
    console.error(`  upserted ${done}/${payload.length}`);
  }
}

// After loading fulfillment_log, refresh customers.serials from it (sheet wins).
async function syncCustomerSerials() {
  const res = await fetch(`${SB_URL}/rest/v1/rpc/sync_customer_serials_from_fulfillment`, {
    method: 'POST',
    headers: {
      apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
    },
    body: '{}',
  });
  if (!res.ok) throw new Error(`serial sync ${res.status}: ${(await res.text()).slice(0, 400)}`);
  const report = await res.json();
  console.error(`  customer serials: ${report.customers_updated} updated, ${report.units_updated} units linked, ${report.unmatched_count} unmatched`);
  if (report.unmatched_count > 0) console.error('  unmatched:', JSON.stringify(report.unmatched));
}

// ----- Main -------------------------------------------------------------------
async function main() {
  const token = await getAccessToken('https://www.googleapis.com/auth/drive.readonly');
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${SHEET_ID}?alt=media&supportsAllDrives=true`,
    { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`drive media ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const wb = readWorkbook(Buffer.from(await res.arrayBuffer()));

  const { rows, report } = buildRows(wb);
  console.error('\nParse report:');
  for (const [tab, r] of Object.entries(report)) console.error(`  ${tab}: kept ${r.kept}, skipped-blank ${r.skipped}`);
  console.error(`  TOTAL rows to load: ${rows.length}\n`);

  if (DRY_RUN) { console.error('--dry-run: not writing.'); return; }

  if (EMIT_BOOTSTRAP) {
    // Compact INSERT (identity columns only) — safe to apply via MCP without a
    // service-role key. ON CONFLICT DO NOTHING so a later full load can enrich.
    mkdirSync('scripts/out', { recursive: true });
    const q = (v) => v === null || v === undefined || v === '' ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`;
    const values = rows.map((r) =>
      `  (${q(r.source_tab)}, ${r.source_row}, ${q(r.customer_name)}, ${q(r.email)}, ` +
      `${q(r.serial_number)}, ${q(JSON.stringify({ serial: r.serial_number, name: r.customer_name, email: r.email, _bootstrap: true }))}::jsonb)`
    ).join(',\n');
    const sql =
      `insert into public.fulfillment_log (source_tab, source_row, customer_name, email, serial_number, raw) values\n` +
      values + `\non conflict (source_tab, source_row) do nothing;`;
    const path = 'scripts/out/fulfillment_bootstrap.sql';
    writeFileSync(path, sql + '\n');
    console.error(`Wrote compact bootstrap SQL (${rows.length} rows) to ${path}`);
    return;
  }

  if (SB_URL && SB_KEY) {
    console.error('Writing via REST upsert...');
    await restUpsert(rows);
    console.error('Syncing customer serials (sheet = source of truth)...');
    await syncCustomerSerials();
    console.error('Done (REST).');
  }
  else { const p = emitSql(rows); console.error(`No SUPABASE_SERVICE_ROLE_KEY — wrote SQL to ${p}`); }
}
main().catch((e) => { console.error('\nERROR:', e.message); process.exit(1); });
