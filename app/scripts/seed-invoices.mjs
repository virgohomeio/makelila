/**
 * seed-invoices.mjs
 * One-time script: bulk-upload QB invoice/receipt PDFs to Supabase Storage
 * and insert records into customer_invoices, auto-matching by customer name.
 *
 * Run from the app/ directory:
 *   cd app
 *   npm install pdf-parse
 *   node scripts/seed-invoices.mjs
 *
 * Env vars (copy from .env.local or set in shell):
 *   VITE_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY   ← service role key, bypasses RLS for bulk insert
 *
 * Idempotent: files already uploaded (same storage_path) are skipped via the
 * UNIQUE constraint on customer_invoices.storage_path.
 */

import { createClient } from '@supabase/supabase-js';
import pdfParse from 'pdf-parse';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ── Config ────────────────────────────────────────────────────────────────────

// Script lives at app/scripts/seed-invoices.mjs
// Backup dir is at  <repo-root>/raw/Invoice and Receipt Backup/Invoice and Receipt Backup
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const BACKUP_DIR = path.resolve(
  SCRIPT_DIR,
  '../../raw/Invoice and Receipt Backup/Invoice and Receipt Backup',
);

const SUPABASE_URL         = process.env.VITE_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseFilename(filename) {
  const base = path.basename(filename, path.extname(filename));

  if (/refund.receipt/i.test(base)) {
    const m = base.match(/(\d+[a-z]?)/i);
    return { invoiceNumber: m ? m[1] : base, documentType: 'refund_receipt' };
  }

  const afterInv = base
    .replace(/^invoice[-_ ]*/i, '')
    .replace(/_from_vcycene_inc.*/i, '')
    .replace(/ \(\d+\)$/, '')
    .trim();
  return { invoiceNumber: afterInv || base, documentType: 'invoice' };
}

function extractPdfFields(text) {
  const billMatch   = text.match(/BILL TO\s*\n([^\n]+)/i);
  const refundMatch = text.match(/REFUND TO\s*\n([^\n]+)/i);
  const rawName = (billMatch?.[1] ?? refundMatch?.[1] ?? '').trim();
  const billToName = rawName.replace(/^(Ms\.|Mr\.|Mrs\.|Dr\.)\s*/i, '').trim() || null;

  const dateMatch = text.match(/\bDATE\b[\s\n]+(\d{2}\/\d{2}\/\d{4})/i);
  let invoiceDate = null;
  if (dateMatch) {
    const [d, m, y] = dateMatch[1].split('/');
    invoiceDate = `${y}-${m}-${d}`;
  }

  const totalMatch = text.match(/TOTAL\s+([\d,]+\.\d{2})/i);
  const totalCad   = totalMatch ? parseFloat(totalMatch[1].replace(',', '')) : null;

  return { billToName, invoiceDate, totalCad };
}

function matchCustomer(billToName, customers) {
  if (!billToName) return null;
  const norm = s => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const target = norm(billToName);

  const exact = customers.find(c => norm(c.full_name) === target);
  if (exact) return exact;

  const parts = target.split(' ');
  if (parts.length >= 2) {
    const lastName = parts[parts.length - 1];
    const partials = customers.filter(c => norm(c.full_name).endsWith(lastName));
    if (partials.length === 1) return partials[0];
  }

  return null;
}

async function uploadToStorage(storagePath, buffer) {
  const { error } = await supabase.storage
    .from('customer-invoices')
    .upload(storagePath, buffer, { contentType: 'application/pdf', upsert: false });
  if (error && !error.message.includes('already exists')) {
    throw new Error(`Storage upload failed: ${error.message}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Reading PDFs from: ${BACKUP_DIR}\n`);

  if (!fs.existsSync(BACKUP_DIR)) {
    console.error(`Backup directory not found: ${BACKUP_DIR}`);
    process.exit(1);
  }

  const { data: customers, error: custErr } = await supabase
    .from('customers')
    .select('id, full_name');
  if (custErr) { console.error('Failed to load customers:', custErr.message); process.exit(1); }
  console.log(`Loaded ${customers.length} customers.\n`);

  const allFiles = fs.readdirSync(BACKUP_DIR)
    .filter(f => f.endsWith('.pdf') && !f.startsWith('._') && !f.startsWith('.'));

  console.log(`Found ${allFiles.length} PDF files.\n`);

  let matched = 0, unmatched = 0, skipped = 0, failed = 0;
  const unmatchedList = [];

  for (const filename of allFiles) {
    const filePath = path.join(BACKUP_DIR, filename);
    const { invoiceNumber, documentType } = parseFilename(filename);

    let billToName = null, invoiceDate = null, totalCad = null;
    try {
      const buffer = fs.readFileSync(filePath);
      const parsed = await pdfParse(buffer);
      ({ billToName, invoiceDate, totalCad } = extractPdfFields(parsed.text));
    } catch (e) {
      console.warn(`  ⚠ Could not parse ${filename}: ${e.message}`);
    }

    const customer   = matchCustomer(billToName, customers);
    const customerId = customer?.id ?? null;
    const safeFile   = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const storagePath = customerId
      ? `invoices/${customerId}/${safeFile}`
      : `invoices/unassigned/${safeFile}`;

    try {
      const buffer = fs.readFileSync(filePath);
      await uploadToStorage(storagePath, buffer);

      const { error: insertErr } = await supabase
        .from('customer_invoices')
        .insert({
          customer_id:    customerId,
          invoice_number: invoiceNumber,
          document_type:  documentType,
          file_name:      filename,
          storage_path:   storagePath,
          invoice_date:   invoiceDate,
          total_cad:      totalCad,
          bill_to_name:   billToName,
          uploaded_by:    'seed-invoices.mjs',
        });

      if (insertErr) {
        if (insertErr.code === '23505') {
          process.stdout.write(`  ⤸ ${filename} — already seeded\n`);
          skipped++;
        } else {
          throw new Error(insertErr.message);
        }
      } else if (customerId) {
        process.stdout.write(`  ✓ ${filename} → ${customer.full_name}\n`);
        matched++;
      } else {
        process.stdout.write(`  ? ${filename} — unmatched (bill_to: ${billToName ?? '—'})\n`);
        unmatched++;
        unmatchedList.push({ filename, billToName });
      }
    } catch (e) {
      console.error(`  ✗ ${filename}: ${e.message}`);
      failed++;
    }
  }

  console.log('\n── Summary ──────────────────────────────────────────');
  console.log(`  Matched to customer : ${matched}`);
  console.log(`  Unmatched (review)  : ${unmatched}`);
  console.log(`  Already seeded      : ${skipped}`);
  console.log(`  Failed              : ${failed}`);

  if (unmatchedList.length > 0) {
    console.log('\nUnmatched — open the customer in the Customers module and click "+ Attach invoice":');
    unmatchedList.forEach(({ filename, billToName }) =>
      console.log(`  • ${filename}  (bill_to: ${billToName ?? '—'})`),
    );
  }
}

main().catch(e => { console.error(e); process.exit(1); });
