import { useCallback, useEffect, useState } from 'react';
import { supabase } from './supabase';
import { logAction } from './activityLog';
import type { CustomerProfitability } from './customers';

// Customer-specific shipping invoices + operator-edited profitability
// adjustments (migration 20261016120000_customer_shipping_invoices.sql).
//
// Sales invoices (lib/invoices.ts) record what a customer PAID us. These record
// what shipping a customer COST us — freight, and the US customs/duty that UPS
// bills the customer directly and that we sometimes cover. Both feed the
// Profitability tab through applyCostAdjustments() below.

export type ShippingCurrency = 'CAD' | 'USD';

export type CustomerShippingInvoice = {
  id: string;
  customer_id: string;
  order_ref: string | null;
  carrier: string | null;
  invoice_number: string | null;
  invoice_date: string | null;          // "YYYY-MM-DD"
  currency: ShippingCurrency;
  freight_amount: number;
  // False when the shipment is already costed by the Freightcom sync — the
  // invoice is kept for the record but not added to the Shipping bucket again.
  counts_in_shipping: boolean;
  customs_amount: number;               // duty/brokerage printed on the invoice
  customs_covered_amount: number;       // the part of it WE paid for the customer
  file_name: string | null;
  storage_path: string | null;
  notes: string | null;
  uploaded_by: string | null;
  created_at: string;
};

export type CustomerProfitabilityAdjustment = {
  customer_id: string;
  currency: ShippingCurrency;
  // Customs we covered with no invoice on file (e.g. reimbursed off a photo).
  customs_covered_amount: number;
  // Replaces the computed Shipping bucket when set. Null = use the computed one.
  shipping_override_amount: number | null;
  note: string | null;
  updated_by: string | null;
  updated_at: string;
};

const BUCKET = 'customer-invoices';

/** PostgREST's "table not in schema cache" — the migration has not been
 *  applied yet. Callers treat it as "no data" so Profitability keeps working. */
function isMissingTable(err: { code?: string } | null): boolean {
  return err?.code === 'PGRST205' || err?.code === '42P01';
}

const MISSING_MSG =
  'Shipping invoices are not set up in the database yet — apply migration 20261016120000_customer_shipping_invoices.sql.';

function num(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function coerceInvoice(r: Record<string, unknown>): CustomerShippingInvoice {
  return {
    ...(r as unknown as CustomerShippingInvoice),
    freight_amount: num(r.freight_amount),
    customs_amount: num(r.customs_amount),
    customs_covered_amount: num(r.customs_covered_amount),
  };
}

function coerceAdjustment(r: Record<string, unknown>): CustomerProfitabilityAdjustment {
  return {
    ...(r as unknown as CustomerProfitabilityAdjustment),
    customs_covered_amount: num(r.customs_covered_amount),
    shipping_override_amount: r.shipping_override_amount == null ? null : num(r.shipping_override_amount),
  };
}

async function currentEmail(): Promise<string | null> {
  const { data } = await supabase.auth.getUser();
  return data.user?.email ?? null;
}

// ── FX ──────────────────────────────────────────────────────────────────────

/** USD→CAD from public.fx_rates — the same company rate the profitability view
 *  converts with, so an uploaded USD duty bill lands on the same basis. */
export async function fetchUsdToCad(): Promise<number> {
  const { data } = await supabase
    .from('fx_rates').select('rate').eq('base', 'USD').eq('quote', 'CAD').maybeSingle();
  const rate = Number((data as { rate?: unknown } | null)?.rate);
  // 1.388889 is the seeded company rate (1 CAD = 0.72 USD); only used if the
  // row can't be read.
  return Number.isFinite(rate) && rate > 0 ? rate : 1.388889;
}

export function toCad(amount: number, currency: ShippingCurrency, usdToCad: number): number {
  return currency === 'USD' ? amount * usdToCad : amount;
}

// ── Shipping invoices ───────────────────────────────────────────────────────

export function useCustomerShippingInvoices(customerId: string | null) {
  const [invoices, setInvoices] = useState<CustomerShippingInvoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!customerId) { setInvoices([]); setLoading(false); return; }
    setLoading(true);
    const { data, error: err } = await supabase
      .from('customer_shipping_invoices')
      .select('*')
      .eq('customer_id', customerId)
      .order('invoice_date', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false });
    setError(err ? (isMissingTable(err) ? MISSING_MSG : err.message) : null);
    setInvoices(((data ?? []) as Record<string, unknown>[]).map(coerceInvoice));
    setLoading(false);
  }, [customerId]);

  useEffect(() => { void load(); }, [load]);
  return { invoices, loading, error, reload: load };
}

export type ShippingInvoiceInput = {
  customerId: string;
  file?: File | null;
  orderRef?: string;
  carrier?: string;
  invoiceNumber?: string;
  invoiceDate?: string;
  currency: ShippingCurrency;
  freightAmount: number;
  countsInShipping: boolean;
  customsAmount: number;
  customsCoveredAmount: number;
  notes?: string;
};

export async function uploadShippingInvoice(input: ShippingInvoiceInput): Promise<void> {
  const { customerId, file } = input;
  let storagePath: string | null = null;

  if (file) {
    const ext = file.name.split('.').pop()?.toLowerCase() ?? 'pdf';
    const safeName = file.name
      .replace(/\.[^.]+$/, '')
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .slice(0, 80);
    storagePath = `shipping/${customerId}/${safeName}_${Date.now()}.${ext}`;
    const { error: upErr } = await supabase.storage
      .from(BUCKET)
      .upload(storagePath, file, { contentType: file.type || 'application/pdf', upsert: false });
    if (upErr) throw new Error(`Upload failed: ${upErr.message}`);
  }

  const { error: insErr } = await supabase.from('customer_shipping_invoices').insert({
    customer_id:            customerId,
    order_ref:              input.orderRef?.trim() || null,
    carrier:                input.carrier?.trim() || null,
    invoice_number:         input.invoiceNumber?.trim() || null,
    invoice_date:           input.invoiceDate || null,
    currency:               input.currency,
    freight_amount:         input.freightAmount,
    counts_in_shipping:     input.countsInShipping,
    customs_amount:         input.customsAmount,
    customs_covered_amount: input.customsCoveredAmount,
    file_name:              file?.name ?? null,
    storage_path:           storagePath,
    notes:                  input.notes?.trim() || null,
    uploaded_by:            await currentEmail(),
  });
  if (insErr) {
    if (storagePath) await supabase.storage.from(BUCKET).remove([storagePath]);
    throw new Error(isMissingTable(insErr) ? MISSING_MSG : `Save failed: ${insErr.message}`);
  }

  await logAction(
    'shipping_invoice_uploaded',
    input.invoiceNumber?.trim() || file?.name || 'shipping invoice',
    `${input.carrier?.trim() || 'Shipping'} invoice: freight ${input.currency} ${input.freightAmount.toFixed(2)}`
      + (input.customsCoveredAmount > 0
        ? `, customs covered ${input.currency} ${input.customsCoveredAmount.toFixed(2)}`
        : ''),
    { entityType: 'customer', entityId: customerId },
  );
}

export async function deleteShippingInvoice(inv: CustomerShippingInvoice): Promise<void> {
  const { error } = await supabase.from('customer_shipping_invoices').delete().eq('id', inv.id);
  if (error) throw new Error(error.message);
  if (inv.storage_path) await supabase.storage.from(BUCKET).remove([inv.storage_path]);
  await logAction(
    'shipping_invoice_deleted',
    inv.invoice_number || inv.file_name || 'shipping invoice',
    `Removed ${inv.carrier || 'shipping'} invoice (freight ${inv.currency} ${inv.freight_amount.toFixed(2)})`,
    { entityType: 'customer', entityId: inv.customer_id },
  );
}

/** Same popup-blocker-safe open as invoices.openInvoiceInNewTab: claim the tab
 *  inside the click, then point it at the signed URL. */
export async function openShippingInvoice(storagePath: string): Promise<void> {
  const tab = window.open('', '_blank');
  if (tab) {
    try { tab.opener = null; } catch { /* harmless */ }
    try { tab.document.write('Loading invoice…'); } catch { /* fine */ }
  }
  try {
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(storagePath, 3600);
    if (error) throw new Error(`Could not generate URL: ${error.message}`);
    if (tab && !tab.closed) tab.location.replace(data.signedUrl);
    else window.location.assign(data.signedUrl);
  } catch (e) {
    try { tab?.close(); } catch { /* gone */ }
    throw e;
  }
}

// ── Profitability adjustments ───────────────────────────────────────────────

export function useProfitabilityAdjustment(customerId: string) {
  const [adjustment, setAdjustment] = useState<CustomerProfitabilityAdjustment | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error: err } = await supabase
      .from('customer_profitability_adjustments')
      .select('*')
      .eq('customer_id', customerId)
      .maybeSingle();
    setError(err ? (isMissingTable(err) ? MISSING_MSG : err.message) : null);
    setAdjustment(data ? coerceAdjustment(data as Record<string, unknown>) : null);
    setLoading(false);
  }, [customerId]);

  useEffect(() => { void load(); }, [load]);
  return { adjustment, loading, error, reload: load };
}

export async function saveProfitabilityAdjustment(params: {
  customerId: string;
  customerName: string;
  currency: ShippingCurrency;
  customsCoveredAmount: number;
  shippingOverrideAmount: number | null;
  note: string;
}): Promise<void> {
  const { error } = await supabase.from('customer_profitability_adjustments').upsert({
    customer_id:              params.customerId,
    currency:                 params.currency,
    customs_covered_amount:   params.customsCoveredAmount,
    shipping_override_amount: params.shippingOverrideAmount,
    note:                     params.note.trim() || null,
    updated_by:               await currentEmail(),
    updated_at:               new Date().toISOString(),
  }, { onConflict: 'customer_id' });
  if (error) throw new Error(isMissingTable(error) ? MISSING_MSG : error.message);

  await logAction(
    'profitability_adjusted',
    params.customerName,
    `Customs covered ${params.currency} ${params.customsCoveredAmount.toFixed(2)}; shipping `
      + (params.shippingOverrideAmount == null
        ? 'computed'
        : `overridden to ${params.currency} ${params.shippingOverrideAmount.toFixed(2)}`)
      + (params.note.trim() ? ` — ${params.note.trim()}` : ''),
    { entityType: 'customer', entityId: params.customerId },
  );
}

// ── Folding into the profitability rows ─────────────────────────────────────

export type CostAdjustmentInputs = {
  invoices: CustomerShippingInvoice[];
  adjustments: CustomerProfitabilityAdjustment[];
  usdToCad: number;
};

/** Everything applyCostAdjustments needs, in one round trip. A missing table
 *  (migration not applied) reads as "no adjustments" rather than an error. */
export async function fetchCostAdjustmentInputs(): Promise<CostAdjustmentInputs> {
  const [inv, adj, usdToCad] = await Promise.all([
    supabase.from('customer_shipping_invoices').select('*'),
    supabase.from('customer_profitability_adjustments').select('*'),
    fetchUsdToCad(),
  ]);
  return {
    invoices: inv.error ? [] : ((inv.data ?? []) as Record<string, unknown>[]).map(coerceInvoice),
    adjustments: adj.error ? [] : ((adj.data ?? []) as Record<string, unknown>[]).map(coerceAdjustment),
    usdToCad,
  };
}

/** Fold uploaded shipping invoices and operator adjustments into the view rows.
 *
 *  - Shipping bucket = override (if set), else the view's freight plus every
 *    uploaded invoice marked counts_in_shipping.
 *  - Customs bucket  = customs covered on invoices + customs covered on the
 *    adjustment row.
 *  - net_margin_cad moves by exactly the change in those two buckets, so every
 *    rollup and sort that reads it stays consistent with the detail panel. */
export function applyCostAdjustments(
  rows: CustomerProfitability[],
  { invoices, adjustments, usdToCad }: CostAdjustmentInputs,
): CustomerProfitability[] {
  const invByCustomer = new Map<string, CustomerShippingInvoice[]>();
  for (const inv of invoices) {
    const list = invByCustomer.get(inv.customer_id) ?? [];
    list.push(inv);
    invByCustomer.set(inv.customer_id, list);
  }
  const adjByCustomer = new Map(adjustments.map(a => [a.customer_id, a]));

  return rows.map(row => {
    const invs = invByCustomer.get(row.id) ?? [];
    const adj = adjByCustomer.get(row.id);
    const computedShipping = row.sale_shipping_cad + row.legacy_shipping_cad;

    let uploadedShipping = 0;
    let invoiceCustoms = 0;
    for (const inv of invs) {
      if (inv.counts_in_shipping) uploadedShipping += toCad(inv.freight_amount, inv.currency, usdToCad);
      invoiceCustoms += toCad(inv.customs_covered_amount, inv.currency, usdToCad);
    }
    const override = adj?.shipping_override_amount == null
      ? null
      : toCad(adj.shipping_override_amount, adj.currency, usdToCad);
    const manualCustoms = adj ? toCad(adj.customs_covered_amount, adj.currency, usdToCad) : 0;
    const customs = round2(invoiceCustoms + manualCustoms);

    const newShipping = override ?? computedShipping + uploadedShipping;
    const delta = (newShipping - computedShipping) + customs;

    return {
      ...row,
      uploaded_shipping_cad: round2(uploadedShipping),
      shipping_invoice_count: invs.length,
      shipping_override_cad: override == null ? null : round2(override),
      customs_covered_cad: customs,
      adjustment_note: adj?.note ?? null,
      net_margin_cad: round2(row.net_margin_cad - delta),
    };
  });
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
