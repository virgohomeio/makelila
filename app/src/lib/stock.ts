import { useEffect, useMemo, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from './supabase';
import { logAction } from './activityLog';

export type UnitStatus =
  | 'in-production' | 'inbound' | 'cn-test' | 'ca-test'
  | 'ready' | 'reserved' | 'rework'
  | 'shipped' | 'team-test' | 'scrap' | 'lost';

export type StatusCategory = 'inbound' | 'warehouse' | 'out';

export const STATUS_META: Record<UnitStatus, {
  label: string;
  category: StatusCategory;
  color: string;          // text color
  bg: string;             // background
  border: string;
}> = {
  'in-production': { label: 'In Production', category: 'inbound',   color: '#6b46c1', bg: '#faf5ff', border: '#d6bcfa' },
  'inbound':       { label: 'Inbound',       category: 'inbound',   color: '#2b6cb0', bg: '#ebf8ff', border: '#bee3f8' },
  'cn-test':       { label: 'CN Test',       category: 'inbound',   color: '#b7791f', bg: '#fffbeb', border: '#ecc94b' },
  'ca-test':       { label: 'CA Test',       category: 'inbound',   color: '#975a16', bg: '#fffbeb', border: '#f6ad55' },
  'ready':         { label: 'Ready',         category: 'warehouse', color: '#276749', bg: '#f0fff4', border: '#9ae6b4' },
  'reserved':      { label: 'Reserved',      category: 'warehouse', color: '#c05621', bg: '#fffaf0', border: '#fbd38d' },
  'rework':        { label: 'Rework',        category: 'warehouse', color: '#9b2c2c', bg: '#fff5f5', border: '#fc8181' },
  'shipped':       { label: 'Shipped',       category: 'out',       color: '#2b6cb0', bg: '#ebf8ff', border: '#bee3f8' },
  'team-test':     { label: 'Team Test',     category: 'out',       color: '#744210', bg: '#fffbeb', border: '#f6ad55' },
  'scrap':         { label: 'Scrap',         category: 'out',       color: '#9b2c2c', bg: '#fff5f5', border: '#fc8181' },
  'lost':          { label: 'Lost',          category: 'out',       color: '#c53030', bg: '#fff5f5', border: '#fc8181' },
};

export const STATUS_ORDER: UnitStatus[] = [
  'in-production','inbound','cn-test','ca-test',
  'ready','reserved','rework',
  'shipped','team-test','scrap','lost',
];

/** Defensive lookup: if a unit somehow has a status that isn't in
 *  STATUS_META (e.g. a DB migration shipped a new status before the
 *  frontend was redeployed), fall back to a neutral gray pill so the
 *  whole page doesn't blank out on `STATUS_META[status].category`. */
const UNKNOWN_META = {
  label: 'Unknown',
  category: 'warehouse' as StatusCategory,
  color: '#4a5568',
  bg: '#f7fafc',
  border: '#cbd5e1',
};
export function getStatusMeta(s: string | null | undefined) {
  if (!s) return UNKNOWN_META;
  return (STATUS_META as Record<string, typeof UNKNOWN_META>)[s] ?? UNKNOWN_META;
}

export type Batch = {
  id: string;
  version: string | null;
  manufacturer: string;
  manufacturer_short: string | null;
  incoterm: string | null;
  unit_cost_usd: number | null;
  total_cost_usd: number | null;
  unit_count: number;
  invoice_no: string | null;
  invoice_date: string | null;
  arrived_at: string | null;
  destination: string | null;
  notes: string | null;
  phases: Array<{ phase: string; start: string; end: string; label: string }>;
  created_at: string;
};

export type UnitColor = 'White' | 'Black';

export type Unit = {
  serial: string;
  batch: string;
  status: UnitStatus;
  color: UnitColor | null;
  location: string | null;
  customer_name: string | null;
  customer_order_ref: string | null;
  carrier: string | null;
  firmware_version: string | null;
  defect_reason: string | null;
  shipped_at: string | null;
  notes: string | null;
  status_updated_at: string;
  status_updated_by: string | null;
  created_at: string;
};

// ---------- hooks ----------

export function useBatches(): { batches: Batch[]; loading: boolean } {
  const [batches, setBatches] = useState<Batch[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let channel: RealtimeChannel | null = null;
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from('batches')
        .select('*')
        .order('invoice_date', { ascending: true, nullsFirst: false });
      if (cancelled) return;
      if (!error && data) setBatches(data as Batch[]);
      setLoading(false);

      channel = supabase
        .channel('batches:realtime')
        .on('postgres_changes',
          { event: '*', schema: 'public', table: 'batches' },
          (payload) => {
            setBatches(prev => {
              if (payload.eventType === 'DELETE' && payload.old) {
                return prev.filter(b => b.id !== (payload.old as { id: string }).id);
              }
              if (payload.new) {
                const row = payload.new as Batch;
                const idx = prev.findIndex(b => b.id === row.id);
                if (idx >= 0) { const next = [...prev]; next[idx] = row; return next; }
                return [...prev, row];
              }
              return prev;
            });
          },
        )
        .subscribe();
    })();
    return () => { cancelled = true; if (channel) void channel.unsubscribe(); };
  }, []);

  return { batches, loading };
}

export function useUnits(): { units: Unit[]; loading: boolean } {
  const [units, setUnits] = useState<Unit[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let channel: RealtimeChannel | null = null;
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from('units')
        .select('*')
        .order('serial', { ascending: true });
      if (cancelled) return;
      if (!error && data) setUnits(data as Unit[]);
      setLoading(false);

      channel = supabase
        .channel('units:realtime')
        .on('postgres_changes',
          { event: '*', schema: 'public', table: 'units' },
          (payload) => {
            setUnits(prev => {
              if (payload.eventType === 'DELETE' && payload.old) {
                return prev.filter(u => u.serial !== (payload.old as { serial: string }).serial);
              }
              if (payload.new) {
                const row = payload.new as Unit;
                const idx = prev.findIndex(u => u.serial === row.serial);
                if (idx >= 0) { const next = [...prev]; next[idx] = row; return next; }
                return [...prev, row];
              }
              return prev;
            });
          },
        )
        .subscribe();
    })();
    return () => { cancelled = true; if (channel) void channel.unsubscribe(); };
  }, []);

  return { units, loading };
}

// ---------- aggregation helpers ----------

export function useStatusCountsByBatch(units: Unit[]): Map<string, Record<UnitStatus, number>> {
  return useMemo(() => {
    const m = new Map<string, Record<UnitStatus, number>>();
    for (const u of units) {
      let row = m.get(u.batch);
      if (!row) {
        row = { 'in-production':0,'inbound':0,'cn-test':0,'ca-test':0,
          'ready':0,'reserved':0,'rework':0,
          'shipped':0,'team-test':0,'scrap':0,'lost':0 };
        m.set(u.batch, row);
      }
      row[u.status]++;
    }
    return m;
  }, [units]);
}

// ---------- mutations ----------

async function currentUserId(): Promise<string> {
  const { data } = await supabase.auth.getUser();
  if (!data.user) throw new Error('stock: not authenticated');
  return data.user.id;
}

export async function updateUnitStatus(
  serial: string,
  newStatus: UnitStatus,
  noteAppend?: string,
): Promise<void> {
  const userId = await currentUserId();
  const { data: existing } = await supabase
    .from('units').select('notes, status').eq('serial', serial).single();
  const nextNotes = noteAppend
    ? [existing?.notes ?? '', noteAppend].filter(Boolean).join('\n')
    : existing?.notes ?? null;
  const { error } = await supabase
    .from('units')
    .update({ status: newStatus, status_updated_by: userId, notes: nextNotes })
    .eq('serial', serial);
  if (error) throw error;
  await logAction('stock_status', serial, `${existing?.status ?? '?'} → ${newStatus}`);
}

export async function updateUnitFields(
  serial: string,
  patch: Partial<Pick<Unit,
    'color' | 'location' | 'customer_name' | 'customer_order_ref' |
    'carrier' | 'firmware_version' | 'defect_reason' | 'shipped_at' | 'notes'
  >>,
): Promise<void> {
  await currentUserId();
  const { error } = await supabase.from('units').update(patch).eq('serial', serial);
  if (error) throw error;
  await logAction('stock_edit', serial, Object.keys(patch).join(', '));
}
