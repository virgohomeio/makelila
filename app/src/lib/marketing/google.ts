import { useEffect, useState } from 'react';
import { supabase } from '../supabase';

// GA4 web analytics + Search Console performance (Marketing → Web tab).

export type Ga4Totals = { sessions: number; users: number; conversions: number };
export type Ga4Channel = { channel: string; sessions: number; conversions: number };

export function useGa4() {
  const [totals, setTotals] = useState<Ga4Totals>({ sessions: 0, users: 0, conversions: 0 });
  const [byChannel, setByChannel] = useState<Ga4Channel[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void supabase.from('ga4_daily').select('channel, sessions, users, conversions').then(({ data }) => {
      if (cancelled) return;
      const rows = (data ?? []) as Array<{ channel: string; sessions: number; users: number; conversions: number }>;
      const t = { sessions: 0, users: 0, conversions: 0 };
      const ch = new Map<string, Ga4Channel>();
      for (const r of rows) {
        t.sessions += r.sessions; t.users += r.users; t.conversions += r.conversions;
        const c = ch.get(r.channel) ?? { channel: r.channel, sessions: 0, conversions: 0 };
        c.sessions += r.sessions; c.conversions += r.conversions;
        ch.set(r.channel, c);
      }
      setTotals(t);
      setByChannel(Array.from(ch.values()).sort((a, b) => b.sessions - a.sessions));
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  return { totals, byChannel, loading };
}

export type GscTotals = { clicks: number; impressions: number; ctr: number; position: number; days: number };

export function useGsc() {
  const [totals, setTotals] = useState<GscTotals>({ clicks: 0, impressions: 0, ctr: 0, position: 0, days: 0 });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void supabase.from('gsc_daily').select('clicks, impressions, position').then(({ data }) => {
      if (cancelled) return;
      const rows = (data ?? []) as Array<{ clicks: number; impressions: number; position: number | null }>;
      let clicks = 0, impressions = 0, posWeighted = 0;
      for (const r of rows) {
        clicks += r.clicks; impressions += r.impressions;
        posWeighted += (r.position ?? 0) * r.impressions;
      }
      setTotals({
        clicks,
        impressions,
        ctr: impressions ? clicks / impressions : 0,
        position: impressions ? posWeighted / impressions : 0,
        days: rows.length,
      });
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  return { totals, loading };
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
