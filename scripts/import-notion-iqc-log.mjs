/**
 * One-shot import of the legacy Notion "Master Issue Log" into build_defects.
 *
 * Usage (PowerShell):
 *   $env:SUPABASE_URL = "..."
 *   $env:SUPABASE_SERVICE_ROLE_KEY = "..."
 *   $env:NOTION_TOKEN = "..."
 *   node scripts/import-notion-iqc-log.mjs
 *
 * Safe to re-run — deduplicates via source_notion_url (notion_page_id column
 * does not exist in build_defects; source_notion_url is used instead).
 *
 * NOTE: unit_serial is NOT NULL in build_defects. Notion pages without a
 * parsable LL01-\d{11} serial that matches a known unit are skipped entirely.
 * Requires: npm install @notionhq/client (not in package.json; install separately).
 */

import { Client } from '@notionhq/client';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_DB_ID = '27fffbba4c38802e9e37d20bd4d201f2';

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !NOTION_TOKEN) {
  console.error('Missing required env vars:');
  if (!SUPABASE_URL)              console.error('  SUPABASE_URL');
  if (!SUPABASE_SERVICE_ROLE_KEY) console.error('  SUPABASE_SERVICE_ROLE_KEY');
  if (!NOTION_TOKEN)              console.error('  NOTION_TOKEN');
  process.exit(1);
}

const notion = new Client({ auth: NOTION_TOKEN });
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const SERIAL_RE = /LL01-\d{11}/;

// ---------------------------------------------------------------------------
// Notion helpers
// ---------------------------------------------------------------------------

/** Extract plain text from a Notion rich_text array. */
function richTextToString(arr) {
  if (!Array.isArray(arr)) return '';
  return arr.map(b => b.plain_text ?? '').join('');
}

/** Extract plain text from a Notion title property. */
function titleToString(prop) {
  return richTextToString(prop?.title ?? []);
}

/** Pull all properties out of a Notion page into a flat object. */
function extractPageFields(page) {
  const props = page.properties ?? {};
  const out = {};
  for (const [key, val] of Object.entries(props)) {
    switch (val.type) {
      case 'title':
        out[key] = titleToString(val);
        break;
      case 'rich_text':
        out[key] = richTextToString(val.rich_text);
        break;
      case 'select':
        out[key] = val.select?.name ?? null;
        break;
      case 'multi_select':
        out[key] = (val.multi_select ?? []).map(o => o.name).join(', ') || null;
        break;
      case 'date':
        out[key] = val.date?.start ?? null;
        break;
      case 'checkbox':
        out[key] = val.checkbox;
        break;
      case 'number':
        out[key] = val.number;
        break;
      case 'url':
        out[key] = val.url ?? null;
        break;
      case 'email':
        out[key] = val.email ?? null;
        break;
      case 'phone_number':
        out[key] = val.phone_number ?? null;
        break;
      default:
        // skip relations, rollups, formulas, etc.
        break;
    }
  }
  return out;
}

/** Paginate through all rows of a Notion database. */
async function fetchAllNotionPages() {
  const pages = [];
  let cursor;
  do {
    const res = await notion.databases.query({
      database_id: NOTION_DB_ID,
      ...(cursor ? { start_cursor: cursor } : {}),
    });
    pages.push(...res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return pages;
}

// ---------------------------------------------------------------------------
// Serial matching
// ---------------------------------------------------------------------------

/** Find the first LL01-XXXXXXXXXXX serial in any string. */
function parseSerial(str) {
  const m = SERIAL_RE.exec(str ?? '');
  return m ? m[0] : null;
}

/** Search all extracted field values for a serial. */
function findSerial(fields) {
  for (const v of Object.values(fields)) {
    if (typeof v === 'string') {
      const s = parseSerial(v);
      if (s) return s;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // 1. Load existing source_notion_url values to support idempotent re-runs.
  const { data: existingRows, error: existingErr } = await supabase
    .from('build_defects')
    .select('source_notion_url')
    .not('source_notion_url', 'is', null)
    .eq('category', 'legacy_iqc_notion');

  if (existingErr) {
    console.error('Failed to load existing build_defects:', existingErr.message);
    process.exit(1);
  }
  const alreadyImported = new Set(
    (existingRows ?? []).map(r => r.source_notion_url).filter(Boolean)
  );
  console.log(`Already imported: ${alreadyImported.size} Notion pages.`);

  // 2. Fetch all Notion pages.
  console.log('Fetching Notion database …');
  let notionPages;
  try {
    notionPages = await fetchAllNotionPages();
  } catch (err) {
    console.error('Failed to query Notion:', err.message);
    process.exit(1);
  }
  console.log(`Fetched ${notionPages.length} pages from Notion.`);

  // 3. Load all known unit serials for FK validation.
  const { data: unitRows, error: unitErr } = await supabase
    .from('units')
    .select('serial');
  if (unitErr) {
    console.error('Failed to load units table:', unitErr.message);
    process.exit(1);
  }
  const knownSerials = new Set((unitRows ?? []).map(r => r.serial));
  console.log(`Loaded ${knownSerials.size} known unit serials.`);

  // 4. Process each Notion page.
  let inserted = 0;
  let skipped = 0;
  let serialMatched = 0;
  let noSerial = 0;

  for (const page of notionPages) {
    const pageUrl = page.url ?? `https://www.notion.so/${page.id.replace(/-/g, '')}`;

    // Dedup check.
    if (alreadyImported.has(pageUrl)) {
      skipped++;
      continue;
    }

    const fields = extractPageFields(page);

    // Find the title (first title-type property wins).
    let subject = '';
    for (const val of Object.values(page.properties ?? {})) {
      if (val.type === 'title') {
        subject = titleToString(val);
        break;
      }
    }
    subject = (subject || '(untitled)').slice(0, 200);

    // Serial detection.
    const candidateSerial = findSerial(subject) ?? findSerial(Object.values(fields).join(' '));
    let unitSerial = null;
    if (candidateSerial && knownSerials.has(candidateSerial)) {
      unitSerial = candidateSerial;
      serialMatched++;
    }

    // unit_serial is NOT NULL in build_defects — skip rows without a valid serial.
    if (!unitSerial) {
      noSerial++;
      console.warn(`  SKIP (no valid serial): "${subject}" [${page.id}]`);
      continue;
    }

    // Build description blob from all text fields + source URL.
    const fieldLines = Object.entries(fields)
      .filter(([, v]) => v !== null && v !== '' && v !== false)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n');
    const description = `Notion source: ${pageUrl}\n\n${fieldLines}`.trim();

    const row = {
      unit_serial:       unitSerial,
      category:          'legacy_iqc_notion',
      subject,
      description,
      severity:          'medium',
      status:            'resolved',
      source_notion_url: pageUrl,
      found_at:          page.created_time,
      resolved_at:       page.last_edited_time,
    };

    const { error: insertErr } = await supabase
      .from('build_defects')
      .insert(row);

    if (insertErr) {
      console.warn(`  WARN: failed to insert "${subject}" [${page.id}]:`, insertErr.message);
    } else {
      inserted++;
    }
  }

  // 5. Summary.
  console.log('\nNotion IQC import complete:');
  console.log(`  fetched:        ${notionPages.length}`);
  console.log(`  inserted:       ${inserted}`);
  console.log(`  skipped:        ${skipped} (already imported)`);
  console.log(`  skipped_no_serial: ${noSerial} (no matching unit serial — NOT NULL constraint)`);
  console.log(`  serial_matched: ${serialMatched}`);
}

main().catch(err => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
