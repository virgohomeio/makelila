// Marketplace orders (Walmart, Best Buy, Mirakl) in Sales and Fulfillment.
//
// Process change of 2026-11-19 (Huayi's build order, items 1, 2 and 4):
//   1. marketplace orders get the queue's Priority flag automatically, and
//      Sales > Pending can be filtered to them;
//   2. their queue due_date is the marketplace Ship By date, entered at
//      Confirm, not the default 7 days;
//   4. Held and Flagged orders share one "Needs attention" view, each with its
//      reason, while staying two separate statuses.
//
// The channel rule itself lives in supabase/functions/_shared/marketplace.ts so
// sync-shopify-orders (the arrival alert) and the app can never disagree.
import { useEffect, useMemo, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from './supabase';
import { logAction } from './activityLog';
import type { Order, OrderNote } from './orders';
import { isMarketplaceChannel, marketplaceOf } from '../../../supabase/functions/_shared/marketplace.ts';

export { isMarketplaceChannel, marketplaceOf };
export type { MarketplaceName } from '../../../supabase/functions/_shared/marketplace.ts';

export function isMarketplaceOrder(o: Pick<Order, 'sales_channel'>): boolean {
  return isMarketplaceChannel(o.sales_channel);
}

// ── 1. Channel filter for the Sales rail ───────────────────────────────────

export type ChannelFilter = 'all' | 'marketplace' | 'website';

export const CHANNEL_FILTER_LABEL: Record<ChannelFilter, string> = {
  all: 'All channels',
  marketplace: 'Marketplace',
  website: 'Our website',
};

/** "website" means everything that is not a marketplace: our storefront, the
 *  subscription checkout channels, drafts and pre-column orders. */
export function matchesChannel(o: Pick<Order, 'sales_channel'>, f: ChannelFilter): boolean {
  if (f === 'all') return true;
  return f === 'marketplace' ? isMarketplaceOrder(o) : !isMarketplaceOrder(o);
}

// ── 2. Ship By date ────────────────────────────────────────────────────────

/** "YYYY-MM-DD" check, because the queue column is a date and anything else
 *  would be stored as whatever Postgres makes of it. */
export function isIsoDay(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T12:00:00`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Display a date column ("YYYY-MM-DD") as the same calendar day locally.
 *  new Date('2026-11-30') is UTC midnight, which renders as Nov 29 anywhere in
 *  North America. */
export function formatIsoDay(s: string | null | undefined): string {
  if (!s) return '';
  const d = new Date(`${s.slice(0, 10)}T12:00:00`);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Set a marketplace order's queue due date to its Ship By date and mark it
 *  priority. Called right after Confirm (the confirm is what creates the queue
 *  row) and from the queue header to correct the date later.
 *
 *  Priority is written here as well as by the enqueue trigger
 *  (20261124120000_marketplace_priority.sql) so it holds before that migration
 *  is applied. Throws when there is no queue row: a Ship By date that lands
 *  nowhere must not look like it was saved. */
export async function setMarketplaceShipBy(
  order: Pick<Order, 'id' | 'order_ref'>,
  shipBy: string,
): Promise<void> {
  if (!isIsoDay(shipBy)) throw new Error(`Ship By date "${shipBy}" is not a valid date.`);
  const { data, error } = await supabase
    .from('fulfillment_queue')
    .update({ due_date: shipBy, priority: true })
    .eq('order_id', order.id)
    .select('id');
  if (error) throw error;
  if (!data || data.length === 0) {
    throw new Error(`${order.order_ref} has no fulfillment queue row yet, so the Ship By date was not saved.`);
  }
  await logAction('fq_ship_by_set', order.order_ref, `Ship By ${shipBy}`, {
    entityType: 'order', entityId: order.id,
  });
}

// ── 4. Needs attention: Held + Flagged with a reason each ──────────────────

export type AttentionStatus = 'held' | 'flagged';

/** Why an order is Held or Flagged, read from the notes the actions write:
 *   - Sales Hold / Flag write "Held: …" / "Flagged: …" (OrderReview Detail);
 *   - the queue's Flag writes "Flagged from the fulfillment queue: …".
 *  The newest matching note wins. An order flagged by the no-phone insert
 *  trigger has no note, so that case is named from the order itself. */
export function attentionReason(
  o: Pick<Order, 'status' | 'customer_phone'>,
  notes: Array<Pick<OrderNote, 'body' | 'created_at' | 'author_name'>>,
): { text: string; by: string | null; at: string | null } {
  const prefixes = o.status === 'held'
    ? ['Held:']
    : ['Flagged from the fulfillment queue:', 'Flagged:'];
  const match = [...notes]
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .find(n => prefixes.some(p => n.body.startsWith(p)));
  if (match) {
    const p = prefixes.find(x => match.body.startsWith(x))!;
    const fromQueue = p.startsWith('Flagged from');
    const text = match.body.slice(p.length).trim();
    return {
      text: (fromQueue ? 'From the queue: ' : '') + (text || 'No reason given'),
      by: match.author_name || null,
      at: match.created_at,
    };
  }
  if (o.status === 'flagged' && !(o.customer_phone ?? '').trim()) {
    return { text: 'No phone number on the order (flagged automatically)', by: null, at: null };
  }
  return { text: 'No reason recorded', by: null, at: null };
}

/** Notes for the orders in Needs attention, one query for the whole rail,
 *  re-read whenever the set of orders changes or a note is added. The note is
 *  written just AFTER the status change, so without the realtime refetch a
 *  freshly held order would show "No reason recorded" until the next reload. */
export function useAttentionNotes(orderIds: string[]): Map<string, OrderNote[]> {
  const key = useMemo(() => [...orderIds].sort().join(','), [orderIds]);
  const [byOrder, setByOrder] = useState<Map<string, OrderNote[]>>(new Map());
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const ids = key ? key.split(',') : [];
    if (ids.length === 0) return;
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from('order_notes')
        .select('id, order_id, author_id, author_name, body, created_at')
        .in('order_id', ids)
        .order('created_at', { ascending: false });
      if (cancelled || error || !data) return;
      const m = new Map<string, OrderNote[]>();
      for (const n of data as OrderNote[]) {
        const list = m.get(n.order_id) ?? [];
        list.push(n);
        m.set(n.order_id, list);
      }
      setByOrder(m);
    })();
    return () => { cancelled = true; };
  }, [key, tick]);

  useEffect(() => {
    let channel: RealtimeChannel | null = supabase
      .channel('order_notes:attention')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'order_notes' },
        () => setTick(t => t + 1))
      .subscribe();
    return () => { if (channel) { void supabase.removeChannel(channel); channel = null; } };
  }, []);

  // No orders: answer empty without a read (and without a stale map).
  return key ? byOrder : EMPTY_NOTES;
}

const EMPTY_NOTES = new Map<string, OrderNote[]>();
