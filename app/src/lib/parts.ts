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

export async function recordPartShipment(input: {
  part_id: string;
  quantity: number;
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
  await logAction('part_ship', input.part_id, `${input.quantity}× to ${input.customer_name ?? 'unknown'}`);
}
