import { useEffect, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from './supabase';
import { logAction } from './activityLog';

// ============================================================================
// Returns
// ============================================================================

export type ReturnStatus =
  | 'created' | 'pickup_scheduled' | 'picked_up' | 'received'
  | 'inspected' | 'refunded' | 'denied' | 'closed';

export type ReturnCondition = 'unused' | 'used' | 'damaged';

export const RETURN_STATUS_META: Record<ReturnStatus, { label: string; color: string; bg: string; border: string }> = {
  'created':          { label: 'Created',    color: '#4a5568', bg: '#f7fafc', border: '#cbd5e1' },
  'pickup_scheduled': { label: 'Pickup Sched',color:'#2b6cb0', bg: '#ebf8ff', border: '#bee3f8' },
  'picked_up':        { label: 'Picked Up',  color: '#2b6cb0', bg: '#ebf8ff', border: '#bee3f8' },
  'received':         { label: 'Received',   color: '#975a16', bg: '#fffbeb', border: '#f6ad55' },
  'inspected':        { label: 'Inspected',  color: '#c05621', bg: '#fffaf0', border: '#fbd38d' },
  'refunded':         { label: 'Refunded',   color: '#276749', bg: '#f0fff4', border: '#9ae6b4' },
  'denied':           { label: 'Denied',     color: '#9b2c2c', bg: '#fff5f5', border: '#fc8181' },
  'closed':           { label: 'Closed',     color: '#718096', bg: '#edf2f7', border: '#cbd5e1' },
};

export const RETURN_STATUS_ORDER: ReturnStatus[] = [
  'created','pickup_scheduled','picked_up','received','inspected','refunded','denied','closed',
];

export type ReturnRow = {
  id: string;
  return_ref: string | null;
  customer_name: string;
  customer_email: string | null;
  channel: 'Canada' | 'USA' | null;
  unit_serial: string | null;
  original_order_ref: string | null;
  condition: ReturnCondition | null;
  reason: string | null;
  refund_amount_usd: number | null;
  status: ReturnStatus;
  pickup_carrier: string | null;
  pickup_tracking: string | null;
  pickup_date: string | null;
  received_at: string | null;
  refund_issued_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

export function useReturns(): { returns: ReturnRow[]; loading: boolean } {
  const [returns, setReturns] = useState<ReturnRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let channel: RealtimeChannel | null = null;
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from('returns')
        .select('*')
        .order('created_at', { ascending: false });
      if (cancelled) return;
      if (!error && data) setReturns(data as ReturnRow[]);
      setLoading(false);

      channel = supabase
        .channel('returns:realtime')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'returns' }, (payload) => {
          setReturns(prev => {
            if (payload.eventType === 'DELETE' && payload.old) {
              return prev.filter(r => r.id !== (payload.old as { id: string }).id);
            }
            if (payload.new) {
              const row = payload.new as ReturnRow;
              const idx = prev.findIndex(r => r.id === row.id);
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

  return { returns, loading };
}

export async function updateReturnStatus(id: string, newStatus: ReturnStatus): Promise<void> {
  const patch: Record<string, unknown> = { status: newStatus };
  if (newStatus === 'received' && !(await hasField(id, 'received_at'))) {
    patch.received_at = new Date().toISOString();
  }
  if (newStatus === 'refunded') {
    patch.refund_issued_at = new Date().toISOString();
  }
  const { error } = await supabase.from('returns').update(patch).eq('id', id);
  if (error) throw error;
  await logAction('return_status', id, `→ ${newStatus}`);
}

async function hasField(id: string, field: string): Promise<boolean> {
  const { data } = await supabase.from('returns').select(field).eq('id', id).single();
  return !!(data as Record<string, unknown> | null)?.[field];
}

// ============================================================================
// Replacement queue
// ============================================================================

export type ReplQueueStatus = 'queued' | 'assigned' | 'shipped' | 'closed';

export type ReplQueueRow = {
  id: string;
  customer_name: string;
  customer_email: string | null;
  original_unit_serial: string | null;
  original_order_ref: string | null;
  batch_preference: string | null;
  priority: boolean;
  assigned_serial: string | null;
  status: ReplQueueStatus;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

export function useReplacementQueue(): { queue: ReplQueueRow[]; loading: boolean } {
  const [queue, setQueue] = useState<ReplQueueRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let channel: RealtimeChannel | null = null;
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from('replacement_queue')
        .select('*')
        .order('priority', { ascending: false })
        .order('created_at', { ascending: true });
      if (cancelled) return;
      if (!error && data) setQueue(data as ReplQueueRow[]);
      setLoading(false);

      channel = supabase
        .channel('replacement_queue:realtime')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'replacement_queue' }, (payload) => {
          setQueue(prev => {
            if (payload.eventType === 'DELETE' && payload.old) {
              return prev.filter(r => r.id !== (payload.old as { id: string }).id);
            }
            if (payload.new) {
              const row = payload.new as ReplQueueRow;
              const idx = prev.findIndex(r => r.id === row.id);
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

  return { queue, loading };
}

/** Assign a specific serial from ready inventory to a queued replacement. */
export async function assignReplacementSerial(id: string, serial: string): Promise<void> {
  const { error } = await supabase.from('replacement_queue')
    .update({ assigned_serial: serial, status: 'assigned' })
    .eq('id', id);
  if (error) throw error;
  await logAction('repl_assign', id, `serial ${serial}`);
}

export async function clearReplacementAssignment(id: string): Promise<void> {
  const { error } = await supabase.from('replacement_queue')
    .update({ assigned_serial: null, status: 'queued' })
    .eq('id', id);
  if (error) throw error;
  await logAction('repl_unassign', id, 'cleared');
}

export async function toggleReplPriority(id: string, value: boolean): Promise<void> {
  const { error } = await supabase.from('replacement_queue')
    .update({ priority: value })
    .eq('id', id);
  if (error) throw error;
  await logAction('repl_priority', id, value ? 'priority' : 'normal');
}

export async function updateReplStatus(id: string, newStatus: ReplQueueStatus): Promise<void> {
  const { error } = await supabase.from('replacement_queue')
    .update({ status: newStatus })
    .eq('id', id);
  if (error) throw error;
  await logAction('repl_status', id, `→ ${newStatus}`);
}
