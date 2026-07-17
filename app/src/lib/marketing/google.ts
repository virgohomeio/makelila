import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../supabase';
import { subscribeReload } from './realtime';

// GA4 web analytics + Search Console performance (Marketing → Web tab).

export type Ga4Totals = { sessions: number; users: number; conversions: number };
export type Ga4Channel = { channel: string; sessions: number; conversions: number };
export type Ga4Row = { date: string; channel: string; sessions: number; users: number; conversions: number };

/** Raw GA4 daily rows (one per date × channel). Aggregate + range-filter in the
 *  component via aggregateGa4 so a date picker can recompute totals live. */
export function useGa4() {
  const [rows, setRows] = useState<Ga4Row[]>([]);
  const [lastSynced, setLastSynced] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase.from('ga4_daily').select('date, channel, sessions, users, conversions, synced_at');
    const raw = (data ?? []) as Array<Ga4Row & { synced_at: string }>;
    let last: string | null = null;
    for (const r of raw) if (r.synced_at && (!last || r.synced_at > last)) last = r.synced_at;
    setRows(raw.map(({ date, channel, sessions, users, conversions }) => ({ date, channel, sessions, users, conversions })));
    setLastSynced(last);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
    return subscribeReload('ga4_daily:realtime', ['ga4_daily'], () => void load());
  }, [load]);

  return { rows, lastSynced, loading, reload: load };
}

export function aggregateGa4(rows: Ga4Row[]): { totals: Ga4Totals; byChannel: Ga4Channel[] } {
  const totals: Ga4Totals = { sessions: 0, users: 0, conversions: 0 };
  const ch = new Map<string, Ga4Channel>();
  for (const r of rows) {
    totals.sessions += r.sessions; totals.users += r.users; totals.conversions += r.conversions;
    const c = ch.get(r.channel) ?? { channel: r.channel, sessions: 0, conversions: 0 };
    c.sessions += r.sessions; c.conversions += r.conversions;
    ch.set(r.channel, c);
  }
  return { totals, byChannel: Array.from(ch.values()).sort((a, b) => b.sessions - a.sessions) };
}

export type GscTotals = { clicks: number; impressions: number; ctr: number; position: number; days: number };
export type GscRow = { date: string; clicks: number; impressions: number; position: number | null };

/** Raw Search Console daily rows. Aggregate + range-filter via aggregateGsc. */
export function useGsc() {
  const [rows, setRows] = useState<GscRow[]>([]);
  const [lastSynced, setLastSynced] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase.from('gsc_daily').select('date, clicks, impressions, position, synced_at');
    const raw = (data ?? []) as Array<GscRow & { synced_at: string }>;
    let last: string | null = null;
    for (const r of raw) if (r.synced_at && (!last || r.synced_at > last)) last = r.synced_at;
    setRows(raw.map(({ date, clicks, impressions, position }) => ({ date, clicks, impressions, position })));
    setLastSynced(last);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
    return subscribeReload('gsc_daily:realtime', ['gsc_daily'], () => void load());
  }, [load]);

  return { rows, lastSynced, loading, reload: load };
}

export function aggregateGsc(rows: GscRow[]): GscTotals {
  let clicks = 0, impressions = 0, posWeighted = 0;
  for (const r of rows) {
    clicks += r.clicks; impressions += r.impressions;
    posWeighted += (r.position ?? 0) * r.impressions;
  }
  return {
    clicks,
    impressions,
    ctr: impressions ? clicks / impressions : 0,
    position: impressions ? posWeighted / impressions : 0,
    days: rows.length,
  };
}

export async function triggerGa4Sync(): Promise<{ synced: number; note?: string }> {
  const { data, error } = await supabase.functions.invoke('sync-ga4');
  if (error) throw error;
  return data as { synced: number; note?: string };
}

export async function triggerGscSync(): Promise<{ synced: number; note?: string }> {
  const { data, error } = await supabase.functions.invoke('sync-search-console');
  if (error) throw error;
  return data as { synced: number; note?: string };
}
