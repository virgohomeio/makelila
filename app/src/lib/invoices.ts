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
  // What the customer actually paid — the invoice's "Payment" line. This, not
  // total_cad, is what a refund is based on: "Total Due" reads $0.00 once the
  // payment has been applied, which is why refund cards used to open at $0.00.
  // Null on invoices ingested before the split, until "Re-read amounts" runs.
  payment_cad: number | null;
  // When the PDF was last read for payment_cad — set even when the invoice has
  // no Payment line, so the backfill doesn't revisit it forever.
  payment_extracted_at: string | null;
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
  // Why the PDF's fields couldn't be read, when the row was still filed. The
  // row lands in the review queue either way, so without this the operator
  // sees "unassigned" with no cause — which is how an extractor that had been
  // dead since 2026-08-13 went unnoticed until every upload needed assigning
  // by hand. Always render it.
  extract_error?: string | null;
  // Which LLM provider read the PDF ('claude' | 'qwen' | 'openai'), null when
  // none could.
  provider?: string | null;
};

/** The amount an invoice is worth in CAD, for display and for defaulting a
 *  refund: the "Payment" figure when we have it, else the invoice total. Both
 *  can be legitimately absent (unparsed PDF), hence null. Zero is treated as
 *  "no usable amount" — a $0.00 total is the "Total Due" artefact this column
 *  pair exists to work around, never a real invoice value. */
export function invoiceAmountCad(inv: Pick<CustomerInvoice, 'payment_cad' | 'total_cad'>): number | null {
  for (const v of [inv.payment_cad, inv.total_cad]) {
    if (v != null && Number(v) > 0) return Number(v);
  }
  return null;
}

/** The invoice to base a refund on for this customer, newest first, preferring
 *  one whose order_ref matches the return's order. Refund receipts are skipped —
 *  a refund is priced off the original sale, not off a previous refund. */
export function pickRefundBasisInvoice(
  invoices: CustomerInvoice[],
  orderRef?: string | null,
): CustomerInvoice | null {
  const sales = invoices.filter(i => i.document_type === 'invoice' && invoiceAmountCad(i) != null);
  if (!sales.length) return null;
  const ref = (orderRef ?? '').trim().replace(/^#/, '');
  if (ref) {
    const onOrder = sales.find(i => (i.order_ref ?? '').trim().replace(/^#/, '') === ref);
    if (onOrder) return onOrder;
  }
  return [...sales].sort((a, b) =>
    (b.invoice_date ?? b.created_at).localeCompare(a.invoice_date ?? a.created_at))[0];
}

/** One customer's invoices, looked up by email — the same email → customer →
 *  invoice chain the Refunds tab renders, but as a one-shot query for callers
 *  outside React (e.g. compiling a return into a refund). */
export async function invoicesForCustomerEmail(email: string): Promise<CustomerInvoice[]> {
  const clean = email.trim().toLowerCase();
  if (!clean) return [];
  const { data: custs } = await supabase
    .from('customers').select('id').ilike('email', clean);
  const ids = ((custs ?? []) as { id: string }[]).map(c => c.id);
  if (!ids.length) return [];
  const { data } = await supabase
    .from('customer_invoices').select('*').in('customer_id', ids);
  return (data ?? []) as CustomerInvoice[];
}

/** Re-read amounts from the stored PDFs for invoices never read for a payment
 *  (i.e. everything ingested before the Payment/Total Due split). One batch per
 *  call; loop while `updated > 0 && remaining > 0`. Rows whose PDF won't parse
 *  come back in `stalled`/`errors` and stay unread, so a loop watching only
 *  `remaining` would never terminate. */
export type ReextractResult = {
  processed: number;
  updated: number;
  remaining: number;
  stalled: number;
  errors: { file_name: string; error: string }[];
  providers?: string[];
};

export async function reextractInvoiceAmounts(limit = 20): Promise<ReextractResult> {
  const { data, error } = await supabase.functions.invoke('match-invoice', {
    body: { reextract: true, limit },
  });
  if (error) throw new Error(error.message);
  const res = data as ReextractResult & { error?: string };
  if (res?.error) throw new Error(res.error);
  return res;
}

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

/** All invoices grouped by lowercased customer email, for surfacing a
 *  customer's original sales invoice + order number on the Refunds tab
 *  (mirrors the customer directory, which keys off customer_id). Joined in
 *  JS via customers.id → email so it doesn't depend on a PostgREST FK embed.
 *  Read-only snapshot (invoices change rarely; the tab refetches on mount). */
export function useInvoicesByCustomerEmail(): {
  byEmail: Map<string, CustomerInvoice[]>;
  loading: boolean;
} {
  const [byEmail, setByEmail] = useState<Map<string, CustomerInvoice[]>>(new Map());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [{ data: custs }, { data: invs }] = await Promise.all([
        supabase.from('customers').select('id, email'),
        supabase
          .from('customer_invoices')
          .select('*')
          .order('invoice_date', { ascending: false, nullsFirst: false })
          .order('created_at', { ascending: false }),
      ]);
      if (cancelled) return;

      const idToEmail = new Map<string, string>();
      for (const c of (custs ?? []) as { id: string; email: string | null }[]) {
        if (c.email) idToEmail.set(c.id, c.email.toLowerCase().trim());
      }
      const m = new Map<string, CustomerInvoice[]>();
      for (const inv of (invs ?? []) as CustomerInvoice[]) {
        const email = inv.customer_id ? idToEmail.get(inv.customer_id) : undefined;
        if (!email) continue;
        const prev = m.get(email) ?? [];
        m.set(email, [...prev, inv]);
      }
      setByEmail(m);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  return { byEmail, loading };
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

/** Open an invoice PDF in a new tab.
 *
 *  Every "View" button used to sign the URL first and only then call
 *  window.open — by which point the await had ended the user-gesture window,
 *  so browsers blocked the tab silently (Safari always, Chrome depending on
 *  how long signing took). The click looked like it did nothing at all.
 *
 *  So claim the tab synchronously inside the gesture, then point it at the
 *  signed URL once we have it. Note the open() deliberately omits 'noopener':
 *  that feature makes the call return null by spec, and we need the handle —
 *  the opener is severed manually instead. If the browser blocked even the
 *  synchronous open, fall back to navigating the current tab so the operator
 *  still gets the PDF. */
export async function openInvoiceInNewTab(storagePath: string): Promise<void> {
  const tab = window.open('', '_blank');
  if (tab) {
    try { tab.opener = null; } catch { /* cross-origin guard; harmless */ }
    try { tab.document.write('Loading invoice…'); } catch { /* not writable; fine */ }
  }
  try {
    const url = await getInvoiceSignedUrl(storagePath);
    if (tab && !tab.closed) tab.location.replace(url);
    else window.location.assign(url);
  } catch (e) {
    try { tab?.close(); } catch { /* already gone */ }
    throw e;
  }
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

    const { data, error } = await supabase.functions.invoke<{
      invoice: CustomerInvoice; extract_error: string | null; provider: string | null;
    }>(
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
    results.push({
      file_name: file.name, ok: true, invoice: data.invoice,
      extract_error: data.extract_error, provider: data.provider,
    });
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
