import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../supabase';
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
  if (error) throw error;
  return data as { synced: number; channels: string[] };
}
