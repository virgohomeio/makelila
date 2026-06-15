/**
 * seed-invoices.mjs
 * One-time script: bulk-upload QB invoice/receipt PDFs to Supabase Storage
 * and insert records into customer_invoices, auto-matching by customer name.
 *
 * Prerequisites:
 *   cd app && npm install pdf-parse
 *
 * Run:
 *   node scripts/seed-invoices.mjs
 *
 * Env vars (set in shell or .env.local):
 *   VITE_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY   ← service role, bypasses RLS for bulk insert
 *
 * The script is idempotent: files already in storage (same storage_path)
 * are skipped via the UNIQUE constraint on customer_invoices.storage_path.
 */

import { createClient } from '@supabase/supabase-js';
import pdfParse from 'pdf-parse';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ── Config ────────────────────────────────────────────────────────────────────

const BACKUP_DIR = path.resolve(
  fileURLToPath(import.meta.url),
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

/** Parse invoice number and document type from filename. */
function parseFilename(filename) {
  const base = path.basename(filename, path.extname(filename));

  // Refund Receipt: Refund_Receipt_1106_from_VCycene_Inc
  if (/refund.receipt/i.test(base)) {
    const m = base.match(/(\d+[a-z]?)/i);
    return { invoiceNumber: m ? m[1] : base, documentType: 'refund_receipt' };
  }

  // Invoice_1002_from_VCycene_Inc  OR  Invoice_Vcycene_P201  OR  Invoice 1136  OR  Invoice-G5WUOB1R-0001
  // Extract the part after "Invoice" (or "Invoice_")
  const afterInv = base.replace(/^invoice[-_ ]*/i, '').replace(/_from_vcycene_inc.*/i, '').replace(/ \(\d+\)$/, '').trim();
  // afterInv is now e.g. "1002", "Vcycene_P201", "G5WUOB1R-0001", "June 02, 2024"
  const invoiceNumber = afterInv || base;
  return { invoiceNumber, documentType: 'invoice' };
}

/** Extract customer name and invoice date from PDF text.
 *  QuickBooks invoice format:
 *    BILL TO\nMs. Yuanbo Luo\n...  (invoice)
 *    REFUND TO\nMr. Tim Li         (refund receipt)
 *    Invoice 1002   DATE 16/07/2023
 */
function extractPdfFields(text) {
  // Customer name
  const billMatch   = text.match(/BILL TO\s*\n([^\n]+)/i);
  const refundMatch = text.match(/REFUND TO\s*\n([^\n]+)/i);
  const rawName = (billMatch?.[1] ?? refundMatch?.[1] ?? '').trim();
  // Strip honorifics: "Ms. ", "Mr. ", "Mrs. ", "Dr. "
  const billToName = rawName.replace(/^(Ms\.|Mr\.|Mrs\.|Dr\.)\s*/i, '').trim() || null;

  // Invoice date: "DATE\n16/07/2023" or "DATE 16/07/2023"
  const dateMatch = text.match(/\bDATE\b[\s\n]+(\d{2}\/\d{2}\/\d{4})/i);
  let invoiceDate = null;
  if (dateMatch) {
    const [d, m, y] = dateMatch[1].split('/');
    invoiceDate = `${y}-${m}-${d}`; // ISO YYYY-MM-DD
  }

  // Total / amount paid
  const totalMatch = text.match(/TOTAL\s+([\d,]+\.\d{2})/i);
  const totalCad   = totalMatch ? parseFloat(totalMatch[1].replace(',', '')) : null;

  return { billToName, invoiceDate, totalCad };
}

/** Fuzzy customer name match: case-insensitive, ignores leading/trailing spaces.
 *  Returns the best-matching customer or null.
 */
function matchCustomer(billToName, customers) {
  if (!billToName) return null;
  const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const target = norm(billToName);

  // 1. Exact match
  const exact = customers.find(c => norm(c.full_name) === target);
  if (exact) return exact;

  // 2. Last name match (useful when invoice has "Yuanbo Luo" and DB has "Luo, Yuanbo" or vice versa)
  const parts = target.split(' ');
  if (parts.length >= 2) {
    const lastName = parts[parts.length - 1];
    const partials = customers.filter(c => norm(c.full_name).endsWith(lastName));
    if (partials.length === 1) return partials[0]; // unique last-name match
  }

  return null;
}

/** Upload a file buffer to Supabase Storage; returns the storage path. */
async function uploadToStorage(storagePath, fileBuffer, mimeType = 'application/pdf') {
  const { error } = await supabase.storage
    .from('customer-invoices')
    .upload(storagePath, fileBuffer, { contentType: mimeType, upsert: false });
  if (error && error.message !== 'The resource already exists') {
    throw new Error(`Storage upload failed: ${error.message}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Reading PDFs from: ${BACKUP_DIR}`);

  if (!fs.existsSync(BACKUP_DIR)) {
    console.error(`Backup directory not found: ${BACKUP_DIR}`);
    process.exit(1);
  }

  // Load all customers for name-matching
  const { data: customers, error: custErr } = await supabase
    .from('customers')
    .select('id, full_name');
  if (custErr) { console.error('Failed to load customers:', custErr.message); process.exit(1); }
  console.log(`Loaded ${customers.length} customers for name-matching.`);

  // All PDF files (skip macOS metadata and .DS_Store)
  const allFiles = fs.readdirSync(BACKUP_DIR)
    .filter(f => f.endsWith('.pdf') && !f.startsWith('._') && !f.startsWith('.'));

  console.log(`Found ${allFiles.length} PDF files.\n`);

  let matched = 0, unmatched = 0, skipped = 0, failed = 0;
  const unmatchedList = [];

  for (const filename of allFiles) {
    const filePath = path.join(BACKUP_DIR, filename);
    const { invoiceNumber, documentType } = parseFilename(filename);

    // Storage path: seed/unassigned or seed/{customer_id}/
    // We determine customer first, then set the path.
    let pdfText = '';
    let billToName = null, invoiceDate = null, totalCad = null;

    try {
      const buffer = fs.readFileSync(filePath);
      const parsed = await pdfParse(buffer);
      pdfText = parsed.text;
      ({ billToName, invoiceDate, totalCad } = extractPdfFields(pdfText));
    } catch (e) {
      console.warn(`  ⚠ Could not parse PDF ${filename}: ${e.message}`);
    }

    const customer = matchCustomer(billToName, customers);
    const customerId = customer?.id ?? null;

    // Sanitize filename for storage key
    const safeFile = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
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
          // Unique violation: already seeded
          console.log(`  ⤸ ${filename} — already in DB, skipped`);
          skipped++;
        } else {
          throw new Error(insertErr.message);
        }
      } else if (customerId) {
        console.log(`  ✓ ${filename} → ${customer.full_name}`);
        matched++;
      } else {
        console.log(`  ? ${filename} — no customer match (bill_to: ${billToName ?? 'unknown'})`);
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
    console.log('\nUnmatched invoices — assign manually in the Customers module:');
    unmatchedList.forEach(({ filename, billToName }) =>
      console.log(`  • ${filename}  (bill_to: ${billToName ?? '—'})`),
    );
  }
}

main().catch(e => { console.error(e); process.exit(1); });
