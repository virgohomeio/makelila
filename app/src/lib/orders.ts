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

export type OrderNote = {
  id: number;
  order_id: string;
  author_id: string;
  author_name: string;
  body: string;
  created_at: string;
};

export type Order = {
  id: string;
  order_ref: string;
  status: OrderStatus;
  customer_name: string;
  customer_email: string | null;
  customer_phone: string | null;
  quo_thread_url: string | null;
  address_line: string | null;
  city: string;
  region_state: string | null;
  country: 'US' | 'CA';
  address_verdict: 'house' | 'apt' | 'remote' | 'condo';
  freight_estimate_usd: number;
  freight_threshold_usd: number;
  total_usd: number;
  line_items: LineItem[];
  sales_confirmed_fit: boolean;
  dispositioned_by: string | null;
  dispositioned_at: string | null;
  created_at: string;
  placed_at: string | null;
};

export type UrgencySeverity = 'ok' | 'urgent' | 'overdue';

export function orderUrgency(placed_at: string | null): {
  days: number | null;
  severity: UrgencySeverity;
  label: string;
} {
  if (!placed_at) return { days: null, severity: 'ok', label: '' };
  const placed = new Date(placed_at); placed.setHours(0, 0, 0, 0);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const days = Math.max(0, Math.round((today.getTime() - placed.getTime()) / 86_400_000));
  if (days > 4)  return { days, severity: 'overdue', label: `${days}d OVERDUE` };
  if (days >= 3) return { days, severity: 'urgent',  label: `${days}d URGENT` };
  return { days, severity: 'ok', label: days === 0 ? 'today' : `${days}d` };
}

/** Due date for the 2-day order-confirmation SLA: placed_at + 2 days.
 *  Severity is keyed off days-since-placement (not days-until-due) so the pill
 *  turns yellow the moment the SLA is missed and red when >4 days have passed. */
export function orderDue(placed_at: string | null): {
  dueDate: Date | null;
  dueLabel: string;
  severity: UrgencySeverity;
} {
  if (!placed_at) return { dueDate: null, dueLabel: '—', severity: 'ok' };
  const placed = new Date(placed_at); placed.setHours(0, 0, 0, 0);
  const due = new Date(placed); due.setDate(due.getDate() + 2);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const days = Math.max(0, Math.round((today.getTime() - placed.getTime()) / 86_400_000));
  const severity: UrgencySeverity = days > 4 ? 'overdue' : days >= 3 ? 'urgent' : 'ok';
  return { dueDate: due, dueLabel: due.toLocaleDateString('en-US'), severity };
}

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

export async function addOrderNote(
  orderId: string,
  authorName: string,
  body: string,
): Promise<void> {
  const userId = await currentUserId();
  const { error } = await supabase.from('order_notes').insert({
    order_id: orderId,
    author_id: userId,
    author_name: authorName,
    body,
  });
  if (error) throw error;
}

export async function setSalesConfirmedFit(id: string, value: boolean): Promise<void> {
  const { error } = await supabase.from('orders').update({ sales_confirmed_fit: value }).eq('id', id);
  if (error) throw error;
}

export async function updateFreightEstimate(id: string, amount: number): Promise<void> {
  const { error } = await supabase.from('orders').update({ freight_estimate_usd: amount }).eq('id', id);
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
  approved: Order[];
  loading: boolean;
} {
  const [cache, setCache] = useState<Order[]>([]);
  const [fulfilledOrderIds, setFulfilledOrderIds] = useState<Set<string>>(new Set());
  // Customer-name match (lowercased) for any shipped unit. Used as a second
  // signal: an order whose customer has a shipped unit is effectively
  // fulfilled even if fulfillment_queue never advanced to step 6 (e.g.
  // orders shipped via the legacy Excel workflow before queue rows existed).
  const [shippedCustomers, setShippedCustomers] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let ordersChannel: RealtimeChannel | null = null;
    let queueChannel: RealtimeChannel | null = null;
    let unitsChannel: RealtimeChannel | null = null;
    let cancelled = false;

    (async () => {
      const [
        { data: ordersData, error: ordersErr },
        { data: queueData, error: queueErr },
        { data: unitsData, error: unitsErr },
      ] = await Promise.all([
        supabase.from('orders').select('*').order('created_at', { ascending: false }),
        supabase.from('fulfillment_queue').select('order_id, step, fulfilled_at'),
        supabase.from('units').select('customer_name, status').eq('status', 'shipped'),
      ]);

      if (cancelled) return;
      if (!ordersErr && ordersData) setCache(ordersData as Order[]);
      if (!queueErr && queueData) {
        setFulfilledOrderIds(new Set(
          (queueData as { order_id: string; step: number; fulfilled_at: string | null }[])
            .filter(q => q.step === 6 || q.fulfilled_at !== null)
            .map(q => q.order_id)
        ));
      }
      if (!unitsErr && unitsData) {
        setShippedCustomers(new Set(
          (unitsData as { customer_name: string | null; status: string }[])
            .map(u => (u.customer_name ?? '').toLowerCase().trim())
            .filter(Boolean)
        ));
      }
      setLoading(false);

      ordersChannel = supabase
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

      queueChannel = supabase
        .channel('orders:fulfillment_queue')
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'fulfillment_queue' },
          (payload) => {
            const row = (payload.new ?? payload.old) as { order_id?: string; step?: number; fulfilled_at?: string | null } | null;
            if (!row?.order_id) return;
            setFulfilledOrderIds(prev => {
              const next = new Set(prev);
              const isFulfilled = (payload.new as { step?: number; fulfilled_at?: string | null } | null);
              if (isFulfilled && (isFulfilled.step === 6 || isFulfilled.fulfilled_at)) {
                next.add(row.order_id!);
              } else {
                next.delete(row.order_id!);
              }
              return next;
            });
          },
        )
        .subscribe();

      unitsChannel = supabase
        .channel('orders:units')
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'units' },
          (payload) => {
            const row = (payload.new ?? payload.old) as { customer_name?: string | null; status?: string } | null;
            const name = (row?.customer_name ?? '').toLowerCase().trim();
            if (!name) return;
            setShippedCustomers(prev => {
              const next = new Set(prev);
              const newStatus = (payload.new as { status?: string } | null)?.status;
              if (newStatus === 'shipped') next.add(name);
              return next;
            });
          },
        )
        .subscribe();
    })();

    return () => {
      cancelled = true;
      if (ordersChannel) void ordersChannel.unsubscribe();
      if (queueChannel) void queueChannel.unsubscribe();
      if (unitsChannel) void unitsChannel.unsubscribe();
    };
  }, []);

  return useMemo(() => {
    // Exclude orders that are fulfilled, by either signal:
    //   (a) fulfillment_queue row reached step 6 / has fulfilled_at, OR
    //   (b) customer has a shipped unit (catches legacy Excel-only shipments
    //       where the queue row was never created or advanced).
    const active = cache.filter(o => {
      if (fulfilledOrderIds.has(o.id)) return false;
      if (shippedCustomers.has(o.customer_name.toLowerCase().trim())) return false;
      return true;
    });
    return {
      all:      active,
      pending:  active.filter(o => o.status === 'pending'),
      held:     active.filter(o => o.status === 'held'),
      flagged:  active.filter(o => o.status === 'flagged'),
      approved: active.filter(o => o.status === 'approved'),
      loading,
    };
  }, [cache, fulfilledOrderIds, shippedCustomers, loading]);
}

export function useOrder(id: string | null): { order: Order | null; loading: boolean } {
  const { all, loading } = useOrders();
  const order = id ? all.find(o => o.id === id) ?? null : null;
  return { order, loading: loading && !order };
}

export function useOrderNotes(orderId: string | null): {
  notes: OrderNote[];
  loading: boolean;
} {
  const [notes, setNotes] = useState<OrderNote[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!orderId) { setNotes([]); setLoading(false); return; }

    let channel: RealtimeChannel | null = null;
    let cancelled = false;

    (async () => {
      const { data, error } = await supabase
        .from('order_notes')
        .select('*')
        .eq('order_id', orderId)
        .order('created_at', { ascending: false });

      if (cancelled) return;
      if (!error && data) setNotes(data as OrderNote[]);
      setLoading(false);

      channel = supabase
        .channel(`order_notes:${orderId}`)
        .on(
          'postgres_changes',
          {
            event: 'INSERT',
            schema: 'public',
            table: 'order_notes',
            filter: `order_id=eq.${orderId}`,
          },
          (payload) => {
            setNotes(prev => [payload.new as OrderNote, ...prev]);
          },
        )
        .subscribe();
    })();

    return () => {
      cancelled = true;
      if (channel) void channel.unsubscribe();
    };
  }, [orderId]);

  return { notes, loading };
}
