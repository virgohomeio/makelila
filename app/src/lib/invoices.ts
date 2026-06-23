import { useCallback, useEffect, useState } from 'react';
import { supabase } from './supabase';

export type InvoiceDocType = 'invoice' | 'refund_receipt';

// How confident the auto-matcher (match-invoice edge function) was:
//   'matched'      — resolved to a sales order (and its customer) by order #
//   'needs_review' — resolved a customer but not an order; operator confirms
//   'unassigned'   — couldn't resolve anyone; operator assigns from scratch
export type InvoiceMatchStatus = 'matched' | 'needs_review' | 'unassigned';

export type CustomerInvoice = {
  id: string;
  customer_id: string | null;
  // Sales order this invoice is attached to (backlog: Upload module). Resolved
  // from the "Shopify order# NNNN" line in the PDF body.
  order_id: string | null;
  order_ref: string | null;
  invoice_number: string;
  document_type: InvoiceDocType;
  file_name: string;
  storage_path: string;
  invoice_date: string | null;   // ISO date "YYYY-MM-DD"
  total_cad: number | null;
  bill_to_name: string | null;
  match_status: InvoiceMatchStatus;
  match_method: string | null;   // 'order_number' | 'email' | 'name' | 'manual' | null
  notes: string | null;
  uploaded_by: string | null;
  created_at: string;
};

export type BulkUploadResult = {
  file_name: string;
  ok: boolean;
  invoice?: CustomerInvoice;
  error?: string;
  extract_error?: string | null;
};

export function useCustomerInvoices(customerId: string) {
  const [invoices, setInvoices] = useState<CustomerInvoice[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from('customer_invoices')
      .select('*')
      .eq('customer_id', customerId)
      .order('invoice_date', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false });
    setInvoices((data ?? []) as CustomerInvoice[]);
    setLoading(false);
  }, [customerId]);

  useEffect(() => { void load(); }, [load]);

  return { invoices, loading, reload: load };
}

export async function uploadInvoice(params: {
  customerId: string;
  file: File;
  invoiceNumber: string;
  documentType: InvoiceDocType;
  invoiceDate?: string;   // "YYYY-MM-DD"
  totalCad?: number;
  notes?: string;
}): Promise<void> {
  const { customerId, file, invoiceNumber, documentType, invoiceDate, totalCad, notes } = params;

  // Sanitize filename: keep extension, replace spaces/parens with underscores
  const ext = file.name.split('.').pop()?.toLowerCase() ?? 'pdf';
  const safeName = file.name
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 80);
  const storagePath = `invoices/${customerId}/${safeName}_${Date.now()}.${ext}`;

  const { error: uploadErr } = await supabase.storage
    .from('customer-invoices')
    .upload(storagePath, file, { contentType: 'application/pdf', upsert: false });
  if (uploadErr) throw new Error(`Upload failed: ${uploadErr.message}`);

  const { error: insertErr } = await supabase
    .from('customer_invoices')
    .insert({
      customer_id:    customerId,
      invoice_number: invoiceNumber.trim(),
      document_type:  documentType,
      file_name:      file.name,
      storage_path:   storagePath,
      invoice_date:   invoiceDate ?? null,
      total_cad:      totalCad ?? null,
      notes:          notes?.trim() || null,
    });
  if (insertErr) {
    // Roll back the storage upload if the DB insert fails
    await supabase.storage.from('customer-invoices').remove([storagePath]);
    throw new Error(`DB insert failed: ${insertErr.message}`);
  }
}

export async function getInvoiceSignedUrl(storagePath: string): Promise<string> {
  const { data, error } = await supabase.storage
    .from('customer-invoices')
    .createSignedUrl(storagePath, 3600); // 1-hour URL
  if (error) throw new Error(`Could not generate URL: ${error.message}`);
  return data.signedUrl;
}

export async function deleteInvoice(id: string, storagePath: string): Promise<void> {
  const { error: dbErr } = await supabase
    .from('customer_invoices')
    .delete()
    .eq('id', id);
  if (dbErr) throw new Error(dbErr.message);
  // Best-effort storage deletion — don't throw if the file is already gone
  await supabase.storage.from('customer-invoices').remove([storagePath]);
}

export async function linkInvoiceToCustomer(invoiceId: string, customerId: string): Promise<void> {
  const { error } = await supabase
    .from('customer_invoices')
    .update({ customer_id: customerId })
    .eq('id', invoiceId);
  if (error) throw new Error(error.message);
}

// ── Bulk auto-match upload (Upload module) ────────────────────────────────

/** Invoices attached to a given sales order — rendered on the Order Review
 *  detail panel. */
export function useInvoicesByOrder(orderId: string | null) {
  const [invoices, setInvoices] = useState<CustomerInvoice[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!orderId) { setInvoices([]); setLoading(false); return; }
    setLoading(true);
    const { data } = await supabase
      .from('customer_invoices')
      .select('*')
      .eq('order_id', orderId)
      .order('invoice_date', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false });
    setInvoices((data ?? []) as CustomerInvoice[]);
    setLoading(false);
  }, [orderId]);

  useEffect(() => { void load(); }, [load]);
  return { invoices, loading, reload: load };
}

/** The review queue: everything the matcher couldn't confidently file
 *  (unassigned + needs_review), newest first. Powers the Upload module's
 *  "Needs review" list. */
export function useReviewQueueInvoices() {
  const [invoices, setInvoices] = useState<CustomerInvoice[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from('customer_invoices')
      .select('*')
      .in('match_status', ['unassigned', 'needs_review'])
      .order('created_at', { ascending: false });
    setInvoices((data ?? []) as CustomerInvoice[]);
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);
  return { invoices, loading, reload: load };
}

/** Upload a batch of invoice PDFs and let the server resolve each one to an
 *  order + customer. Uploads to an `inbound/` prefix (the owner isn't known
 *  until the PDF is parsed), then calls the match-invoice edge function which
 *  parses, matches, and inserts the customer_invoices row. Per-file outcomes
 *  are returned so the UI can show which matched vs. need review. */
export async function bulkUploadAndMatch(
  files: File[],
  documentType: InvoiceDocType,
): Promise<BulkUploadResult[]> {
  const results: BulkUploadResult[] = [];
  for (const file of files) {
    const ext = file.name.split('.').pop()?.toLowerCase() ?? 'pdf';
    const safeName = file.name
      .replace(/\.[^.]+$/, '')
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .slice(0, 80);
    const storagePath = `inbound/${crypto.randomUUID()}_${safeName}.${ext}`;

    const { error: upErr } = await supabase.storage
      .from('customer-invoices')
      .upload(storagePath, file, { contentType: 'application/pdf', upsert: false });
    if (upErr) {
      results.push({ file_name: file.name, ok: false, error: `Upload failed: ${upErr.message}` });
      continue;
    }

    const { data, error } = await supabase.functions.invoke<{ invoice: CustomerInvoice; extract_error: string | null }>(
      'match-invoice',
      { body: { storage_path: storagePath, file_name: file.name, document_type: documentType } },
    );
    if (error || !data?.invoice) {
      // Roll back the orphaned upload so a failed match doesn't leave a file
      // with no row pointing at it.
      await supabase.storage.from('customer-invoices').remove([storagePath]);
      results.push({ file_name: file.name, ok: false, error: error?.message ?? 'No response from matcher' });
      continue;
    }
    results.push({ file_name: file.name, ok: true, invoice: data.invoice, extract_error: data.extract_error });
  }
  return results;
}

/** Manual assignment from the review queue: link an invoice to a customer
 *  and/or order and mark it matched. */
export async function assignInvoice(
  invoiceId: string,
  params: { customerId?: string | null; orderId?: string | null; orderRef?: string | null },
): Promise<void> {
  const patch: Record<string, unknown> = { match_status: 'matched', match_method: 'manual' };
  if ('customerId' in params) patch.customer_id = params.customerId ?? null;
  if ('orderId' in params)    patch.order_id    = params.orderId ?? null;
  if ('orderRef' in params)   patch.order_ref   = params.orderRef ?? null;
  const { error } = await supabase
    .from('customer_invoices')
    .update(patch)
    .eq('id', invoiceId);
  if (error) throw new Error(error.message);
}
