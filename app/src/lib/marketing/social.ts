import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../supabase';
import { fnErrorMessage } from './fnError';
import { subscribeReload } from './realtime';

export type SocialChannel = 'facebook' | 'instagram' | 'youtube' | 'linkedin' | 'tiktok';

export type SocialMetric = {
  channel: SocialChannel;
  as_of: string;
  followers: number | null;
  reach: number | null;
  impressions: number | null;
  engagement: number | null;
  posts: number | null;
  views: number | null;
  synced_at: string;
};

// Latest row per channel (organic social). Each platform's sync upserts its own
// channel into social_metrics; this returns the most recent day per channel.
export function useSocialLatest() {
  const [byChannel, setByChannel] = useState<Map<SocialChannel, SocialMetric>>(new Map());
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const { data } = await supabase
      .from('social_metrics')
      .select('*')
      .order('as_of', { ascending: false });
    const m = new Map<SocialChannel, SocialMetric>();
    for (const r of (data ?? []) as SocialMetric[]) {
      if (!m.has(r.channel)) m.set(r.channel, r); // desc order → first seen is latest
    }
    setByChannel(m);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
    return subscribeReload('social_metrics:realtime', ['social_metrics'], () => void load());
  }, [load]);

  return { byChannel, loading };
}

/** Pull organic Facebook Page + linked Instagram metrics (reuses the Meta token
 *  + META_PAGE_ID). The other channels need their own apps and aren't here yet. */
export async function triggerFbIgSync(): Promise<{ synced: number; channels: string[] }> {
  const { data, error } = await supabase.functions.invoke('sync-social-organic');
  if (error) throw new Error(await fnErrorMessage(error));
  return data as { synced: number; channels: string[] };
}

// Every organic-social sync. Runs them in parallel; each is independent, so one
// failing (e.g. LinkedIn before approval) doesn't block the rest. Returns a
// short per-platform ok/failed summary for the button's status line.
const SOCIAL_SYNCS: { fn: string; label: string }[] = [
  { fn: 'sync-social-organic', label: 'FB+IG' },
  { fn: 'sync-youtube-organic', label: 'YouTube' },
  { fn: 'sync-tiktok-organic', label: 'TikTok' },
  { fn: 'sync-linkedin-organic', label: 'LinkedIn' },
];

export async function triggerAllSocialSync(): Promise<string> {
  const results = await Promise.allSettled(
    SOCIAL_SYNCS.map(async s => {
      const { error } = await supabase.functions.invoke(s.fn);
      if (error) throw new Error(await fnErrorMessage(error));
      return s.label;
    }),
  );
  const ok: string[] = [], failed: string[] = [];
  results.forEach((r, i) => (r.status === 'fulfilled' ? ok : failed).push(SOCIAL_SYNCS[i].label));
  return `Synced ${ok.join(', ') || 'none'}${failed.length ? ` · failed: ${failed.join(', ')}` : ''}.`;
}
