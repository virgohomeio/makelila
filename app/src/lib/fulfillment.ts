import { useEffect, useMemo, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from './supabase';

export type FulfillmentStep = 1 | 2 | 3 | 4 | 5 | 6;
export type ShelfSlotStatus = 'available' | 'reserved' | 'rework' | 'empty';

export type FulfillmentQueueRow = {
  id: string;
  order_id: string;
  step: FulfillmentStep;
  assigned_serial: string | null;

  test_report_url: string | null;
  test_confirmed_at: string | null;
  test_confirmed_by: string | null;

  carrier: string | null;
  tracking_num: string | null;
  label_pdf_path: string | null;
  label_confirmed_at: string | null;
  label_confirmed_by: string | null;

  dock_printed: boolean;
  dock_affixed: boolean;
  dock_docked: boolean;
  dock_notified: boolean;
  dock_confirmed_at: string | null;
  dock_confirmed_by: string | null;

  starter_tracking_num: string | null;
  email_sent_at: string | null;
  email_sent_by: string | null;

  fulfilled_at: string | null;
  fulfilled_by: string | null;

  due_date: string | null;
  created_at: string;
};

export type ShelfSlot = {
  skid: string;
  slot_index: number;
  serial: string | null;
  batch: string | null;
  status: ShelfSlotStatus;
  updated_at: string;
};

export type UnitRework = {
  id: number;
  serial: string;
  skid: string | null;
  slot_index: number | null;
  order_id: string | null;
  issue: string;
  flagged_by: string;
  flagged_by_name: string;
  flagged_at: string;
  resolved_by: string | null;
  resolved_by_name: string | null;
  resolved_at: string | null;
  resolution_notes: string | null;
};

// --- useFulfillmentQueue ---

export function useFulfillmentQueue(): {
  all: FulfillmentQueueRow[];
  ready: FulfillmentQueueRow[];
  fulfilled: FulfillmentQueueRow[];
  loading: boolean;
} {
  const [cache, setCache] = useState<FulfillmentQueueRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let channel: RealtimeChannel | null = null;
    let cancelled = false;

    (async () => {
      const { data, error } = await supabase
        .from('fulfillment_queue')
        .select('*')
        .order('due_date', { ascending: true });
      if (cancelled) return;
      if (!error && data) setCache(data as FulfillmentQueueRow[]);
      setLoading(false);

      channel = supabase
        .channel('fulfillment_queue:realtime')
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'fulfillment_queue' },
          (payload) => {
            setCache(prev => {
              if (payload.eventType === 'DELETE' && payload.old) {
                return prev.filter(r => r.id !== (payload.old as { id: string }).id);
              }
              if (payload.new) {
                const row = payload.new as FulfillmentQueueRow;
                const idx = prev.findIndex(r => r.id === row.id);
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

  return useMemo(() => ({
    all: cache,
    ready: cache.filter(r => r.step < 6),
    fulfilled: cache.filter(r => r.step === 6),
    loading,
  }), [cache, loading]);
}

// --- useShelf ---

export function useShelf(): { slots: ShelfSlot[]; loading: boolean } {
  const [slots, setSlots] = useState<ShelfSlot[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let channel: RealtimeChannel | null = null;
    let cancelled = false;

    (async () => {
      const { data, error } = await supabase
        .from('shelf_slots')
        .select('*')
        .order('skid', { ascending: true })
        .order('slot_index', { ascending: true });
      if (cancelled) return;
      if (!error && data) setSlots(data as ShelfSlot[]);
      setLoading(false);

      channel = supabase
        .channel('shelf_slots:realtime')
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'shelf_slots' },
          (payload) => {
            setSlots(prev => {
              const row = payload.new as ShelfSlot | null;
              if (!row) return prev;
              const idx = prev.findIndex(s => s.skid === row.skid && s.slot_index === row.slot_index);
              if (idx >= 0) { const next = [...prev]; next[idx] = row; return next; }
              return [...prev, row];
            });
          },
        )
        .subscribe();
    })();

    return () => { cancelled = true; if (channel) void channel.unsubscribe(); };
  }, []);

  return { slots, loading };
}

// --- useOpenReworks ---

export function useOpenReworks(): { reworks: UnitRework[]; loading: boolean } {
  const [reworks, setReworks] = useState<UnitRework[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let channel: RealtimeChannel | null = null;
    let cancelled = false;

    (async () => {
      const { data, error } = await supabase
        .from('unit_reworks')
        .select('*')
        .is('resolved_at', null)
        .order('flagged_at', { ascending: false });
      if (cancelled) return;
      if (!error && data) setReworks(data as UnitRework[]);
      setLoading(false);

      channel = supabase
        .channel('unit_reworks:realtime')
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'unit_reworks' },
          (payload) => {
            setReworks(prev => {
              if (payload.eventType === 'INSERT' && payload.new) {
                return [payload.new as UnitRework, ...prev];
              }
              if (payload.eventType === 'UPDATE' && payload.new) {
                const row = payload.new as UnitRework;
                if (row.resolved_at) return prev.filter(r => r.id !== row.id);
                const idx = prev.findIndex(r => r.id === row.id);
                if (idx >= 0) { const next = [...prev]; next[idx] = row; return next; }
              }
              return prev;
            });
          },
        )
        .subscribe();
    })();

    return () => { cancelled = true; if (channel) void channel.unsubscribe(); };
  }, []);

  return { reworks, loading };
}
