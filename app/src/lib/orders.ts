import { useEffect, useMemo, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from './supabase';
import { logAction } from './activityLog';

export type OrderStatus = 'pending' | 'approved' | 'flagged' | 'held';

export type LineItem = {
  sku: string;
  name: string;
  qty: number;
  price_usd: number;
};

export type Order = {
  id: string;
  order_ref: string;
  status: OrderStatus;
  customer_name: string;
  customer_email: string | null;
  customer_phone: string | null;
  quo_thread_url: string | null;
  address_line: string;
  city: string;
  region_state: string | null;
  country: 'US' | 'CA';
  address_verdict: 'house' | 'apt' | 'remote' | 'condo';
  freight_estimate_usd: number;
  freight_threshold_usd: number;
  total_usd: number;
  line_items: LineItem[];
  notes: string;
  dispositioned_by: string | null;
  dispositioned_at: string | null;
  created_at: string;
};

const ACTION_TYPE: Record<Exclude<OrderStatus, 'pending'>, string> = {
  approved: 'order_approve',
  flagged:  'order_flag',
  held:     'order_hold',
};

async function currentUserId(): Promise<string> {
  const { data } = await supabase.auth.getUser();
  if (!data.user) throw new Error('orders: not authenticated');
  return data.user.id;
}

export async function disposition(
  order: Pick<Order, 'id' | 'order_ref' | 'customer_name'>,
  status: Exclude<OrderStatus, 'pending'>,
  reason?: string,
): Promise<void> {
  const userId = await currentUserId();

  const { error } = await supabase
    .from('orders')
    .update({
      status,
      dispositioned_by: userId,
      dispositioned_at: new Date().toISOString(),
    })
    .eq('id', order.id);
  if (error) throw error;

  await logAction(ACTION_TYPE[status], order.order_ref, reason ?? order.customer_name);
}

export async function needInfo(
  order: Pick<Order, 'id' | 'order_ref' | 'customer_name'>,
  note?: string,
): Promise<void> {
  await logAction('order_need_info', order.order_ref, note ?? order.customer_name);
}

export async function updateNotes(id: string, notes: string): Promise<void> {
  const { error } = await supabase.from('orders').update({ notes }).eq('id', id);
  if (error) throw error;
}

function applyChange(cache: Order[], payload: { eventType: string; new: Order | null; old: { id: string } | null }): Order[] {
  if (payload.eventType === 'DELETE' && payload.old) {
    return cache.filter(o => o.id !== payload.old!.id);
  }
  if (payload.new) {
    const existing = cache.findIndex(o => o.id === payload.new!.id);
    if (existing >= 0) {
      const next = [...cache];
      next[existing] = payload.new;
      return next;
    }
    return [payload.new, ...cache];
  }
  return cache;
}

export function useOrders(): {
  all: Order[];
  pending: Order[];
  held: Order[];
  flagged: Order[];
  loading: boolean;
} {
  const [cache, setCache] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let channel: RealtimeChannel | null = null;
    let cancelled = false;

    (async () => {
      const { data, error } = await supabase
        .from('orders')
        .select('*')
        .order('created_at', { ascending: false });

      if (cancelled) return;
      if (!error && data) setCache(data as Order[]);
      setLoading(false);

      channel = supabase
        .channel('orders:realtime')
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'orders' },
          (payload) => {
            setCache(prev => applyChange(prev, {
              eventType: payload.eventType,
              new: payload.new as Order | null,
              old: payload.old as { id: string } | null,
            }));
          },
        )
        .subscribe();
    })();

    return () => {
      cancelled = true;
      if (channel) void channel.unsubscribe();
    };
  }, []);

  return useMemo(() => ({
    all:     cache,
    pending: cache.filter(o => o.status === 'pending'),
    held:    cache.filter(o => o.status === 'held'),
    flagged: cache.filter(o => o.status === 'flagged'),
    loading,
  }), [cache, loading]);
}

export function useOrder(id: string | null): { order: Order | null; loading: boolean } {
  const { all, loading } = useOrders();
  const order = id ? all.find(o => o.id === id) ?? null : null;
  return { order, loading: loading && !order };
}
