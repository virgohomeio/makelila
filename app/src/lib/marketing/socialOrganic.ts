import { useEffect, useState } from 'react';
import { supabase } from '../supabase';

// Organic social metrics (one row per channel per day), synced by the
// sync-social-organic edge function. Followers/posts are point-in-time stock;
// reach/engagement are trailing-28-day flow. Kept separate from paid ads.

export type SocialMetricRow = {
  channel: string;              // 'facebook' | 'instagram' | 'youtube' | 'tiktok' | 'linkedin' | …
  as_of: string;                // YYYY-MM-DD
  followers: number | null;
  reach: number | null;         // trailing 28 days
  impressions: number | null;
  engagement: number | null;    // trailing 28 days
  posts: number | null;
  views: number | null;
};

/** Latest row per channel (most recent as_of), for the dashboard overview. */
export function useSocialMetrics(): { rows: SocialMetricRow[]; loading: boolean } {
  const [rows, setRows] = useState<SocialMetricRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void supabase
      .from('social_metrics')
      .select('channel, as_of, followers, reach, impressions, engagement, posts, views')
      .order('as_of', { ascending: false })
      .limit(120)
      .then(({ data, error }) => {
        if (cancelled) return;
        if (!error && data) {
          // Keep the newest row per channel (data is already as_of-desc).
          const latest = new Map<string, SocialMetricRow>();
          for (const r of data as SocialMetricRow[]) if (!latest.has(r.channel)) latest.set(r.channel, r);
          setRows([...latest.values()]);
        }
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  return { rows, loading };
}

// Display order + labels for the channels we track (present ones render).
export const SOCIAL_CHANNELS: { key: string; label: string }[] = [
  { key: 'facebook', label: 'Facebook' },
  { key: 'instagram', label: 'Instagram' },
  { key: 'youtube', label: 'YouTube' },
  { key: 'tiktok', label: 'TikTok' },
  { key: 'linkedin', label: 'LinkedIn' },
  { key: 'twitter', label: 'X / Twitter' },
  { key: 'pinterest', label: 'Pinterest' },
  { key: 'threads', label: 'Threads' },
];
