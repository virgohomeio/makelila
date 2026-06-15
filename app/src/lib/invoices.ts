import { useCallback, useEffect, useState } from 'react';
import { supabase } from './supabase';

export type InvoiceDocType = 'invoice' | 'refund_receipt';

export type CustomerInvoice = {
  id: string;
  customer_id: string | null;
  invoice_number: string;
  document_type: InvoiceDocType;
  file_name: string;
  storage_path: string;
  invoice_date: string | null;   // ISO date "YYYY-MM-DD"
  total_cad: number | null;
  bill_to_name: string | null;
  notes: string | null;
  uploaded_by: string | null;
  created_at: string;
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
