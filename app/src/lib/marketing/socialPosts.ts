import { useEffect, useState } from 'react';
import { supabase } from '../supabase';

// Per-post organic social metrics across platforms (social_posts), plus a
// per-channel overview derived from social_metrics (current + 28-day delta).
// Powers the Social tab's cross-platform post comparison + the dashboard totals.
// Because the team posts the same content the same day everywhere, posts are
// grouped by posted_date = "same post across platforms".

export type SocialPost = {
  platform: string;
  post_id: string;
  posted_at: string | null;
  posted_date: string | null;
  caption: string | null;
  permalink: string | null;
  media_type: string | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  reach: number | null;
  engagement: number | null;
};

export type ChannelOverview = {
  channel: string;
  followers: number | null;
  followersDelta: number | null;   // latest − earliest snapshot within the window
  reach: number | null;
  engagement: number | null;
  views: number | null;            // social_metrics.views (lifetime for YouTube)
  posts: number | null;
  as_of: string | null;
};

type MetricRow = {
  channel: string; as_of: string;
  followers: number | null; reach: number | null; engagement: number | null;
  views: number | null; posts: number | null;
};

const WINDOW_DAYS = 35;   // a bit over 28 so the comparison has context

export function useSocialOverview(): { posts: SocialPost[]; channels: ChannelOverview[]; loading: boolean } {
  const [posts, setPosts] = useState<SocialPost[]>([]);
  const [channels, setChannels] = useState<ChannelOverview[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const cutoff = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
      const [metricsRes, postsRes] = await Promise.all([
        supabase.from('social_metrics')
          .select('channel, as_of, followers, reach, engagement, views, posts')
          .gte('as_of', cutoff).order('as_of', { ascending: false }),
        supabase.from('social_posts')
          .select('platform, post_id, posted_at, posted_date, caption, permalink, media_type, views, likes, comments, shares, reach, engagement')
          .gte('posted_date', cutoff).order('posted_date', { ascending: false }),
      ]);
      if (cancelled) return;

      // Per channel: first row (as_of desc) is latest; last seen is earliest in window.
      const byCh = new Map<string, { latest: MetricRow; earliest: MetricRow }>();
      for (const r of (metricsRes.data ?? []) as MetricRow[]) {
        const e = byCh.get(r.channel);
        if (!e) byCh.set(r.channel, { latest: r, earliest: r });
        else e.earliest = r;
      }
      const ch: ChannelOverview[] = [];
      for (const [channel, { latest, earliest }] of byCh) {
        const delta = latest.followers != null && earliest.followers != null && latest !== earliest
          ? latest.followers - earliest.followers : null;
        ch.push({
          channel, followers: latest.followers, followersDelta: delta,
          reach: latest.reach, engagement: latest.engagement, views: latest.views,
          posts: latest.posts, as_of: latest.as_of,
        });
      }
      setChannels(ch);
      setPosts((postsRes.data ?? []) as SocialPost[]);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  return { posts, channels, loading };
}

export type PostDay = { date: string; caption: string | null; byPlatform: Record<string, SocialPost> };

/** One row per posted_date, with the matching post per platform (same day = same
 *  post). If a platform posted twice in a day, keep the higher-engagement one. */
export function groupPostsByDate(posts: SocialPost[]): PostDay[] {
  const days = new Map<string, PostDay>();
  for (const p of posts) {
    if (!p.posted_date) continue;
    let d = days.get(p.posted_date);
    if (!d) { d = { date: p.posted_date, caption: null, byPlatform: {} }; days.set(p.posted_date, d); }
    const prev = d.byPlatform[p.platform];
    if (!prev || (p.engagement ?? 0) > (prev.engagement ?? 0)) d.byPlatform[p.platform] = p;
    if (p.caption && (!d.caption || p.caption.length > d.caption.length)) d.caption = p.caption;
  }
  return [...days.values()].sort((a, b) => b.date.localeCompare(a.date));
}
