// Standalone Google Sheets/Drive reader for a service account.
// No npm deps — mints the RS256 JWT with Node's built-in crypto.
//
// Usage:
//   GSA_KEY_PATH=.secrets/lila-bot.json SHEET_ID=<id> node scripts/read-sheet.mjs [TAB_NAME] [MAX_ROWS]
//
// Auto-detects whether the file is a native Google Sheet (Sheets API) or an
// uploaded .xlsx (Drive API CSV export) and prints the header row + sample rows.

import { readFileSync } from 'node:fs';
import { createSign } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

const KEY_PATH = process.env.GSA_KEY_PATH;
const SHEET_ID = process.env.SHEET_ID;
const TAB = process.argv[2] || null;            // optional tab/sheet name
const MAX_ROWS = Number(process.argv[3] || 8);  // header + this many data rows

if (!KEY_PATH || !SHEET_ID) {
  console.error('Set GSA_KEY_PATH and SHEET_ID env vars. See header of this file.');
  process.exit(1);
}

const sa = JSON.parse(readFileSync(KEY_PATH, 'utf8'));

function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function getAccessToken(scope) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: sa.client_email,
    scope,
    aud: sa.token_uri,
    iat: now,
    exp: now + 3600,
  }));
  const signingInput = `${header}.${claims}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  const signature = b64url(signer.sign(sa.private_key));
  const assertion = `${signingInput}.${signature}`;

  const res = await fetch(sa.token_uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  const json = await res.json();
  if (!res.ok || !json.access_token) {
    throw new Error(`token endpoint ${res.status}: ${JSON.stringify(json)}`);
  }
  return json.access_token;
}

function parseCsv(text) {
  // Minimal RFC-4180 CSV parser (handles quotes, commas, newlines in quotes).
  const rows = [];
  let row = [], field = '', i = 0, inQ = false;
  while (i < text.length) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i += 2; continue; }
      if (c === '"') { inQ = false; i++; continue; }
      field += c; i++; continue;
    }
    if (c === '"') { inQ = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// ---- Minimal XLSX reader (zero deps): unzip via zlib + parse the XML ----
function unzip(buf) {
  // Find End Of Central Directory record (scan backward for sig 0x06054b50).
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip (no EOCD)');
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
    // Local header: data starts after its own name+extra fields.
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);
    files[name] = method === 0 ? raw : inflateRawSync(raw);
    off += 46 + nameLen + extraLen + commLen;
  }
  return files;
}

function decodeXmlEntities(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&amp;/g, '&');
}

function colToIndex(ref) {
  const m = ref.match(/^([A-Z]+)/);
  let n = 0;
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function parseXlsx(buf, wantTab) {
  const files = unzip(buf);
  const dec = (name) => files[name] ? files[name].toString('utf8') : '';

  // Shared strings table.
  const shared = [];
  const ssXml = dec('xl/sharedStrings.xml');
  for (const si of ssXml.match(/<si>[\s\S]*?<\/si>/g) || []) {
    const parts = si.match(/<t[^>]*>([\s\S]*?)<\/t>/g) || [];
    shared.push(parts.map(t => decodeXmlEntities(t.replace(/<[^>]+>/g, ''))).join(''));
  }

  // Map sheet name -> worksheet xml path via workbook.xml + rels.
  const wbXml = dec('xl/workbook.xml');
  const relsXml = dec('xl/_rels/workbook.xml.rels');
  const relMap = {};
  for (const r of relsXml.match(/<Relationship[^>]*>/g) || []) {
    const id = (r.match(/Id="([^"]+)"/) || [])[1];
    const tgt = (r.match(/Target="([^"]+)"/) || [])[1];
    if (id && tgt) relMap[id] = tgt.replace(/^\/?xl\//, '').replace(/^\//, '');
  }
  const sheets = [];
  for (const s of wbXml.match(/<sheet[^>]*\/?>/g) || []) {
    const name = decodeXmlEntities((s.match(/name="([^"]*)"/) || [])[1] || '');
    const rid = (s.match(/r:id="([^"]+)"/) || [])[1];
    sheets.push({ name, path: relMap[rid] ? `xl/${relMap[rid]}` : null });
  }
  console.error('Tabs:', sheets.map(s => s.name).join(', '));

  const target = wantTab
    ? sheets.find(s => s.name.toLowerCase() === wantTab.toLowerCase())
    : sheets[0];
  if (!target || !target.path) throw new Error(`tab not found: ${wantTab || '(first)'}`);
  console.error(`Reading tab: ${target.name}`);

  // Parse the worksheet into a 2D array.
  const wsXml = dec(target.path);
  const rows = [];
  for (const rowXml of wsXml.match(/<row[\s\S]*?<\/row>/g) || []) {
    const cells = [];
    for (const cMatch of rowXml.match(/<c[^>]*>[\s\S]*?<\/c>|<c[^>]*\/>/g) || []) {
      const ref = (cMatch.match(/r="([A-Z]+\d+)"/) || [])[1];
      const type = (cMatch.match(/t="([^"]+)"/) || [])[1];
      const idx = ref ? colToIndex(ref) : cells.length;
      let val = '';
      if (type === 's') {
        const v = (cMatch.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        val = v !== undefined ? (shared[+v] ?? '') : '';
      } else if (type === 'inlineStr') {
        const t = cMatch.match(/<t[^>]*>([\s\S]*?)<\/t>/);
        val = t ? decodeXmlEntities(t[1]) : '';
      } else {
        const v = (cMatch.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        val = v !== undefined ? decodeXmlEntities(v) : '';
      }
      cells[idx] = val;
    }
    for (let i = 0; i < cells.length; i++) if (cells[i] === undefined) cells[i] = '';
    rows.push(cells);
  }
  return rows;
}

function printRows(rows) {
  if (!rows.length) { console.log('(no rows)'); return; }
  const headers = rows[0];
  console.log(`\nCOLUMNS (${headers.length}):`);
  headers.forEach((h, idx) => console.log(`  [${idx}] ${JSON.stringify(h)}`));
  console.log(`\nSAMPLE ROWS (showing up to ${MAX_ROWS - 1}):`);
  for (let r = 1; r < Math.min(rows.length, MAX_ROWS); r++) {
    console.log(`  row ${r}:`);
    headers.forEach((h, idx) => {
      const v = rows[r][idx];
      if (v !== undefined && v !== '') console.log(`      ${h}: ${JSON.stringify(v)}`);
    });
  }
  console.log(`\nTotal rows fetched: ${rows.length} (incl. header)`);
}

async function main() {
  // 1) Detect the file type via Drive metadata.
  const driveToken = await getAccessToken('https://www.googleapis.com/auth/drive.readonly');
  const metaRes = await fetch(
    `https://www.googleapis.com/drive/v3/files/${SHEET_ID}?fields=id,name,mimeType&supportsAllDrives=true`,
    { headers: { Authorization: `Bearer ${driveToken}` } },
  );
  const meta = await metaRes.json();
  if (!metaRes.ok) throw new Error(`drive metadata ${metaRes.status}: ${JSON.stringify(meta)}`);
  console.error(`File: ${meta.name}  (${meta.mimeType})`);

  if (meta.mimeType === 'application/vnd.google-apps.spreadsheet') {
    // Native Google Sheet → Sheets API.
    const sheetsToken = await getAccessToken('https://www.googleapis.com/auth/spreadsheets.readonly');
    if (!TAB) {
      const sres = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}?fields=sheets.properties(title,gridProperties)`,
        { headers: { Authorization: `Bearer ${sheetsToken}` } });
      const sjson = await sres.json();
      console.error('Tabs:', (sjson.sheets || []).map(s => s.properties.title).join(', '));
    }
    const range = TAB ? `${TAB}!A1:ZZ${MAX_ROWS}` : `A1:ZZ${MAX_ROWS}`;
    const vres = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}`,
      { headers: { Authorization: `Bearer ${sheetsToken}` } });
    const vjson = await vres.json();
    if (!vres.ok) throw new Error(`sheets values ${vres.status}: ${JSON.stringify(vjson)}`);
    printRows(vjson.values || []);
  } else {
    // Uploaded .xlsx → download raw bytes (alt=media) and parse the workbook.
    const mediaRes = await fetch(
      `https://www.googleapis.com/drive/v3/files/${SHEET_ID}?alt=media&supportsAllDrives=true`,
      { headers: { Authorization: `Bearer ${driveToken}` } });
    if (!mediaRes.ok) {
      const t = await mediaRes.text();
      throw new Error(`drive media ${mediaRes.status}: ${t.slice(0, 400)}`);
    }
    const buf = Buffer.from(await mediaRes.arrayBuffer());
    printRows(parseXlsx(buf, TAB));
  }
}

main().catch((e) => { console.error('\nERROR:', e.message); process.exit(1); });
