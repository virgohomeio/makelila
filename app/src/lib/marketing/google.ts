import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../supabase';
import { subscribeReload } from './realtime';

// GA4 web analytics + Search Console performance (Marketing → Web tab).

export type Ga4Totals = { sessions: number; users: number; conversions: number };
export type Ga4Channel = { channel: string; sessions: number; conversions: number };

export function useGa4() {
  const [totals, setTotals] = useState<Ga4Totals>({ sessions: 0, users: 0, conversions: 0 });
  const [byChannel, setByChannel] = useState<Ga4Channel[]>([]);
  const [lastSynced, setLastSynced] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase.from('ga4_daily').select('channel, sessions, users, conversions, synced_at');
    const rows = (data ?? []) as Array<{ channel: string; sessions: number; users: number; conversions: number; synced_at: string }>;
    const t = { sessions: 0, users: 0, conversions: 0 };
    const ch = new Map<string, Ga4Channel>();
    let last: string | null = null;
    for (const r of rows) {
      t.sessions += r.sessions; t.users += r.users; t.conversions += r.conversions;
      const c = ch.get(r.channel) ?? { channel: r.channel, sessions: 0, conversions: 0 };
      c.sessions += r.sessions; c.conversions += r.conversions;
      ch.set(r.channel, c);
      if (r.synced_at && (!last || r.synced_at > last)) last = r.synced_at;
    }
    setTotals(t);
    setByChannel(Array.from(ch.values()).sort((a, b) => b.sessions - a.sessions));
    setLastSynced(last);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
    return subscribeReload('ga4_daily:realtime', ['ga4_daily'], () => void load());
  }, [load]);

  return { totals, byChannel, lastSynced, loading, reload: load };
}

export type GscTotals = { clicks: number; impressions: number; ctr: number; position: number; days: number };

export function useGsc() {
  const [totals, setTotals] = useState<GscTotals>({ clicks: 0, impressions: 0, ctr: 0, position: 0, days: 0 });
  const [lastSynced, setLastSynced] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase.from('gsc_daily').select('clicks, impressions, position, synced_at');
    const rows = (data ?? []) as Array<{ clicks: number; impressions: number; position: number | null; synced_at: string }>;
    let clicks = 0, impressions = 0, posWeighted = 0;
    let last: string | null = null;
    for (const r of rows) {
      clicks += r.clicks; impressions += r.impressions;
      posWeighted += (r.position ?? 0) * r.impressions;
      if (r.synced_at && (!last || r.synced_at > last)) last = r.synced_at;
    }
    setTotals({
      clicks,
      impressions,
      ctr: impressions ? clicks / impressions : 0,
      position: impressions ? posWeighted / impressions : 0,
      days: rows.length,
    });
    setLastSynced(last);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
    return subscribeReload('gsc_daily:realtime', ['gsc_daily'], () => void load());
  }, [load]);

  return { totals, lastSynced, loading, reload: load };
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
