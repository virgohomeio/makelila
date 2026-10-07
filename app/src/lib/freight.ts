import { useCallback, useEffect, useState } from 'react';
import { supabase } from './supabase';
import { logAction } from './activityLog';
import { functionErrorMessage } from './functionError';

export type FreightcomPackageInput = {
  weight_kg: number;
  length_cm: number;
  width_cm: number;
  height_cm: number;
  description?: string;
};

export type FreightQuote = {
  id: string;
  order_id: string;
  provider: 'clickship' | 'freightcom';
  service_level: string;
  rate_cad: number | null;
  rate_usd: number | null;
  transit_days: number | null;
  quoted_at: string;
  selected: boolean;
  raw: Record<string, unknown>;
};

/** Cheapest quote carrying a CAD rate, or null when none does. Quotes priced
 *  only in USD are skipped: freight_estimate_usd is displayed as CAD, so a USD
 *  figure can neither be compared against the CAD rates nor written to the
 *  order without mispricing it. */
export function cheapestCadQuote(quotes: FreightQuote[]): FreightQuote | null {
  const priced = quotes.filter(q => q.rate_cad != null);
  if (priced.length === 0) return null;
  return priced.reduce((best, q) => (q.rate_cad! < best.rate_cad! ? q : best));
}

export function useQuotes(orderId: string | null): {
  quotes: FreightQuote[];
  loading: boolean;
  /** Re-read the quote list — call after pulling fresh rates so the history
   *  table updates without a page reload. */
  refetch: () => Promise<void>;
} {
  const [quotes, setQuotes] = useState<FreightQuote[]>([]);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!orderId) { setQuotes([]); setLoading(false); return; }
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from('freight_quotes')
        .select('*')
        .eq('order_id', orderId)
        .order('quoted_at', { ascending: false });
      if (!cancelled) {
        if (!error && data) setQuotes(data as FreightQuote[]);
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [orderId, nonce]);

  const refetch = useCallback(async () => { setNonce(n => n + 1); }, []);

  return { quotes, loading, refetch };
}

export async function selectQuote(orderId: string, quoteId: string): Promise<void> {
  const { data: quote, error: qErr } = await supabase
    .from('freight_quotes')
    .select('id, provider, service_level, rate_cad, rate_usd')
    .eq('id', quoteId)
    .eq('order_id', orderId)
    .single();
  if (qErr) throw new Error(qErr.message);

  const { error: e1 } = await supabase
    .from('freight_quotes')
    .update({ selected: false })
    .eq('order_id', orderId);
  if (e1) throw new Error(e1.message);

  const { error: e2 } = await supabase
    .from('freight_quotes')
    .update({ selected: true })
    .eq('id', quoteId)
    .eq('order_id', orderId);
  if (e2) throw new Error(e2.message);

  // Selecting a quote is the moment the order acquires a freight estimate.
  // Without this the carrier rate lived only in freight_quotes and Sales →
  // Freight Estimate kept reading "$0.00 · operator edit" no matter how many
  // quotes had been pulled. Only a CAD rate is copied: freight_estimate_usd is
  // rendered as CAD (Freightcom prices our account in CAD regardless of the
  // customer's own currency), so writing a USD figure there would misprice it.
  if (quote?.rate_cad != null) {
    const { error: e3 } = await supabase
      .from('orders')
      .update({
        freight_estimate_usd: quote.rate_cad,
        freight_estimate_source: quote.provider,
      })
      .eq('id', orderId);
    if (e3) throw new Error(e3.message);
  }

  await logAction(
    'freight_quote_selected',
    orderId,
    `quote_id=${quoteId} rate_cad=${quote?.rate_cad ?? 'n/a'}`,
    { entityType: 'order', entityId: orderId },
  );
}

export async function insertQuote(
  orderId: string,
  provider: FreightQuote['provider'],
  serviceLevel: string,
  rateCad: number | null,
  rateUsd: number | null,
  transitDays: number | null,
  raw: Record<string, unknown>,
): Promise<FreightQuote> {
  const { data, error } = await supabase
    .from('freight_quotes')
    .insert({
      order_id: orderId,
      provider,
      service_level: serviceLevel,
      rate_cad: rateCad,
      rate_usd: rateUsd,
      transit_days: transitDays,
      raw,
    })
    .select()
    .single();
  if (error) throw new Error(error.message);

  await logAction(
    'freight_quote_created',
    orderId,
    `provider=${provider} rate_cad=${rateCad}`,
    { entityType: 'order', entityId: orderId },
  );

  return data as FreightQuote;
}

/** What a quote run was actually asked about. A rate is only an estimate of
 *  THIS order's freight if the carrier was asked about this order's destination
 *  and this order's number of boxes, so the function reports both back and
 *  Sales shows them beside the number. */
export type QuoteRun = {
  quotes: FreightQuote[];
  /** The postal code the carrier rated. */
  quoted_postal: string | null;
  /** 'verified' means address verification found the customer's own code wrong
   *  and the quote was re-pointed at the postal authority's. */
  quoted_postal_source: 'customer' | 'verified';
  package_count: number;
  unit_count: number;
  address_verified_at: string | null;
};

/** Pull live carrier rates and report the full context of the run. */
export async function fetchFreightcomQuoteRun(
  orderId: string,
  packages?: FreightcomPackageInput[],
): Promise<QuoteRun> {
  const { data, error } = await supabase.functions.invoke('freightcom-quote', {
    body: { order_id: orderId, ...(packages ? { packages } : {}) },
  });
  // Unwrap the function's own { error } body — the default supabase-js message
  // ("non-2xx status code") is why a hard "Order not found" from every single
  // quote attempt read as a transient network problem for two months.
  if (error) throw new Error(await functionErrorMessage(error));
  const run = (data ?? {}) as Partial<QuoteRun> & { count?: number };
  await logAction(
    'freightcom_quotes_fetched',
    orderId,
    `count=${run.count ?? 0} packages=${run.package_count ?? '?'} postal=${run.quoted_postal ?? '?'}`,
    { entityType: 'order', entityId: orderId },
  );
  return {
    quotes: run.quotes ?? [],
    quoted_postal: run.quoted_postal ?? null,
    quoted_postal_source: run.quoted_postal_source === 'verified' ? 'verified' : 'customer',
    package_count: run.package_count ?? 1,
    unit_count: run.unit_count ?? 1,
    address_verified_at: run.address_verified_at ?? null,
  };
}

export async function fetchFreightcomQuotes(
  orderId: string,
  packages?: FreightcomPackageInput[],
): Promise<FreightQuote[]> {
  return (await fetchFreightcomQuoteRun(orderId, packages)).quotes;
}

/** One line of a carrier's own pricing for this address. The rate payload names
 *  them — 'residential-delivery', 'extended-area', 'fuel' — and they are the
 *  only place a quote says WHY this address costs what it costs. */
export type QuoteSurcharge = { type: string; label: string; amount_cad: number };

const SURCHARGE_LABEL: Record<string, string> = {
  fuel:                   'Fuel',
  'residential-delivery': 'Residential delivery',
  'extended-area':        'Extended / rural area',
  'rural-delivery':       'Rural delivery',
  'liftgate-delivery':    'Liftgate',
  'signature-required':   'Signature',
  'address-correction':   'Address correction',
  oversize:               'Oversize',
};

function titleCase(type: string): string {
  return type.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

/** The surcharges Freightcom itemised on a quote — the cheapest available
 *  answer to "what about this address moved the price". Returns [] for a quote
 *  whose raw payload we never captured (older rows, ClickShip pastes). */
export function quoteSurcharges(quote: FreightQuote | null | undefined): QuoteSurcharge[] {
  const raw = quote?.raw as {
    surcharges?: Array<{ type?: string; amount?: { value?: string; currency?: string } }>;
  } | undefined;
  const out: QuoteSurcharge[] = [];
  for (const s of raw?.surcharges ?? []) {
    const type = s?.type ?? '';
    if (!type) continue;
    const cents = Number.parseInt(s?.amount?.value ?? '', 10);
    if (!Number.isFinite(cents) || cents === 0) continue;
    out.push({ type, label: SURCHARGE_LABEL[type] ?? titleCase(type), amount_cad: cents / 100 });
  }
  return out;
}
