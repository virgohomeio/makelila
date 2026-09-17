import { useEffect, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from './supabase';
import { logAction } from './activityLog';

export type PartCategory = 'replacement' | 'consumable';

export type Part = {
  id: string;
  sku: string;
  name: string;
  category: PartCategory;
  kind: string | null;
  supplier: string | null;
  supplier_url: string | null;
  cost_per_unit_usd: number | null;
  on_hand: number;
  reorder_point: number;
  /** Operator-typed Demand. null = use the count derived from un-shipped
   *  replacement orders. Absent until migration 20260917120000 is applied. */
  demand_override?: number | null;
  location: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

export type PartShipment = {
  id: string;
  part_id: string;
  quantity: number;
  customer_name: string | null;
  linked_unit_serial: string | null;
  linked_order_ref: string | null;
  carrier: string | null;
  tracking_num: string | null;
  shipped_at: string | null;
  notes: string | null;
  created_at: string;
};

// ---------- hooks ----------

export function useParts(): { parts: Part[]; loading: boolean } {
  const [parts, setParts] = useState<Part[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let channel: RealtimeChannel | null = null;
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from('parts')
        .select('*')
        .order('category', { ascending: true })
        .order('name', { ascending: true });
      if (cancelled) return;
      if (!error && data) setParts(data as Part[]);
      setLoading(false);

      channel = supabase
        .channel('parts:realtime')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'parts' }, (payload) => {
          setParts(prev => {
            if (payload.eventType === 'DELETE' && payload.old) {
              return prev.filter(p => p.id !== (payload.old as { id: string }).id);
            }
            if (payload.new) {
              const row = payload.new as Part;
              const idx = prev.findIndex(p => p.id === row.id);
              if (idx >= 0) { const next = [...prev]; next[idx] = row; return next; }
              return [...prev, row];
            }
            return prev;
          });
        })
        .subscribe();
    })();
    return () => { cancelled = true; if (channel) void channel.unsubscribe(); };
  }, []);

  return { parts, loading };
}

export function usePartShipments(): { shipments: PartShipment[]; loading: boolean } {
  const [shipments, setShipments] = useState<PartShipment[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let channel: RealtimeChannel | null = null;
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from('part_shipments')
        .select('*')
        .order('shipped_at', { ascending: false, nullsFirst: false })
        .order('created_at', { ascending: false });
      if (cancelled) return;
      if (!error && data) setShipments(data as PartShipment[]);
      setLoading(false);

      channel = supabase
        .channel('part_shipments:realtime')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'part_shipments' }, (payload) => {
          setShipments(prev => {
            if (payload.eventType === 'DELETE' && payload.old) {
              return prev.filter(s => s.id !== (payload.old as { id: string }).id);
            }
            if (payload.new) {
              const row = payload.new as PartShipment;
              const idx = prev.findIndex(s => s.id === row.id);
              if (idx >= 0) { const next = [...prev]; next[idx] = row; return next; }
              return [row, ...prev];
            }
            return prev;
          });
        })
        .subscribe();
    })();
    return () => { cancelled = true; if (channel) void channel.unsubscribe(); };
  }, []);

  return { shipments, loading };
}

// ---------- mutations ----------

export async function adjustPartStock(partId: string, delta: number, reason: string): Promise<void> {
  // Read-modify-write — small data so contention isn't a concern.
  const { data, error: rErr } = await supabase
    .from('parts').select('on_hand').eq('id', partId).single();
  if (rErr) throw rErr;
  const next = Math.max(0, (data?.on_hand ?? 0) + delta);
  const { error } = await supabase.from('parts').update({ on_hand: next }).eq('id', partId);
  if (error) throw error;
  await logAction('part_stock_adjust', partId, `${delta > 0 ? '+' : ''}${delta} (${reason})`);
}

/** Fields an operator can type over in Stock › Parts. */
export type PartEditableField = 'on_hand' | 'demand_override' | 'reorder_point' | 'cost_per_unit_usd';

const FIELD_LABEL: Record<PartEditableField, string> = {
  on_hand: 'on hand',
  demand_override: 'demand',
  reorder_point: 'reorder at',
  cost_per_unit_usd: 'cost',
};

/** Parse what an operator typed into an editable cell. Returns undefined when
 *  the input is not a valid value for that field. Blank is only valid where
 *  the column is nullable: demand (back to the derived count) and cost. */
export function parsePartFieldInput(
  field: PartEditableField,
  raw: string,
): number | null | undefined {
  const t = raw.trim().replace(/^\$/, '');
  if (t === '') return field === 'demand_override' || field === 'cost_per_unit_usd' ? null : undefined;
  if (field === 'cost_per_unit_usd') {
    if (!/^\d+(\.\d{0,2})?$|^\.\d{1,2}$/.test(t)) return undefined;
    return Number(t);
  }
  if (!/^\d+$/.test(t)) return undefined;
  return parseInt(t, 10);
}

/** Set one number on a part, as typed. Unlike adjustPartStock this is an
 *  absolute write (a stock count, a price), not a delta. */
export async function updatePartField(
  part: Pick<Part, 'id' | 'sku'> & Partial<Record<PartEditableField, number | null>>,
  field: PartEditableField,
  value: number | null,
): Promise<void> {
  const { error } = await supabase.from('parts').update({ [field]: value }).eq('id', part.id);
  if (error) throw error;
  const fmt = (v: number | null | undefined) =>
    v == null ? (field === 'demand_override' ? 'auto' : '—')
      : field === 'cost_per_unit_usd' ? `$${Number(v).toFixed(2)}` : String(v);
  await logAction('part_edit', part.id, `${part.sku} ${FIELD_LABEL[field]}: ${fmt(part[field])} → ${fmt(value)}`);
}

/** Demand per SKU as every screen should read it: the derived count from
 *  replacement orders, replaced wherever an operator has typed an override.
 *  Overrides of 0 are kept (so the SKU reads 0, not the derived count). */
export function effectiveDemandBySku(
  derived: Map<string, number>,
  parts: Array<Pick<Part, 'sku' | 'demand_override'>>,
): Map<string, number> {
  const m = new Map(derived);
  for (const p of parts) {
    if (p.demand_override != null) m.set(p.sku, p.demand_override);
  }
  return m;
}

export async function recordPartShipment(input: {
  part_id: string;
  quantity: number;
  customer_id?: string;
  customer_name?: string;
  linked_unit_serial?: string;
  linked_order_ref?: string;
  carrier?: string;
  tracking_num?: string;
  shipped_at?: string;
  notes?: string;
}): Promise<void> {
  const { error } = await supabase.from('part_shipments').insert({
    ...input,
    shipped_at: input.shipped_at ?? new Date().toISOString(),
  });
  if (error) throw error;
  await logAction('part_ship', input.part_id, `${input.quantity}× to ${input.customer_name ?? input.customer_id ?? 'unknown'}`);
}
