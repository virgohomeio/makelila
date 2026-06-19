import { useEffect, useState } from 'react';
import { supabase } from './supabase';
import { logAction } from './activityLog';

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

export function useQuotes(orderId: string | null): { quotes: FreightQuote[]; loading: boolean } {
  const [quotes, setQuotes] = useState<FreightQuote[]>([]);
  const [loading, setLoading] = useState(true);

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
  }, [orderId]);

  return { quotes, loading };
}

export async function selectQuote(orderId: string, quoteId: string): Promise<void> {
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

  await logAction(
    'freight_quote_selected',
    orderId,
    `quote_id=${quoteId}`,
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

export async function fetchFreightcomQuotes(
  orderId: string,
  packages?: FreightcomPackageInput[],
): Promise<FreightQuote[]> {
  const { data, error } = await supabase.functions.invoke('freightcom-quote', {
    body: { order_id: orderId, ...(packages ? { packages } : {}) },
  });
  if (error) throw new Error(error.message);
  await logAction(
    'freightcom_quotes_fetched',
    orderId,
    `count=${(data as { count?: number })?.count ?? 0}`,
    { entityType: 'order', entityId: orderId },
  );
  return (data as { quotes: FreightQuote[] }).quotes;
}
