// sync-youtube-organic: pull organic YouTube channel metrics into social_metrics
// (channel = 'youtube'). Uses the YouTube Data API v3 with a plain API KEY —
// channel + video stats are public, so no OAuth is needed. (Reach / watch time /
// demographics need the YouTube Analytics API + owner OAuth — a separate, later
// upgrade; left null here, the same honest approach as Facebook impressions.)
//
// Captured: followers = subscriberCount, posts = videoCount, views = lifetime
// channel viewCount, engagement = likes + comments on videos published in the
// trailing 28 days (summed from each recent video's public statistics).
//
// Secrets: YOUTUBE_API_KEY (required), YOUTUBE_CHANNEL_ID (optional UC… id) or
// YOUTUBE_HANDLE (optional, defaults to @vcycene).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { corsHeaders } from '../_shared/cors.ts';
import { authenticate } from '../_shared/auth.ts';

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: corsHeaders });

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceKey) return j({ error: 'Missing Supabase env' }, 500);
  const admin = createClient(supabaseUrl, serviceKey);

  try { await authenticate(req, admin); }
  catch (e) { if (e instanceof Response) return e; throw e; }

  const apiKey = Deno.env.get('YOUTUBE_API_KEY');
  if (!apiKey) return j({ error: 'Not configured: set YOUTUBE_API_KEY in Edge Function secrets.' }, 400);
  const channelIdEnv = Deno.env.get('YOUTUBE_CHANNEL_ID');
  const handle = Deno.env.get('YOUTUBE_HANDLE') ?? '@vcycene';
  const base = 'https://www.googleapis.com/youtube/v3';
  const key = encodeURIComponent(apiKey);

  const num = (v: unknown): number | null => (v != null && v !== '' ? Number(v) : null);
  const getJson = async (url: string): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> => {
    const res = await fetch(url);
    const body = await res.json().catch(() => ({})) as Record<string, unknown>;
    return { ok: res.ok, status: res.status, body };
  };
  const errMsg = (body: Record<string, unknown>, status: number): string =>
    String((body as { error?: { message?: string } }).error?.message ?? status).slice(0, 160);

  // 1) Resolve the channel (by id if given, else by handle) + its statistics.
  const chUrl = channelIdEnv
    ? `${base}/channels?part=statistics,contentDetails,snippet&id=${encodeURIComponent(channelIdEnv)}&key=${key}`
    : `${base}/channels?part=statistics,contentDetails,snippet&forHandle=${encodeURIComponent(handle)}&key=${key}`;
  const ch = await getJson(chUrl);
  if (!ch.ok) return j({ error: `YouTube channels ${ch.status}: ${errMsg(ch.body, ch.status)}` }, 502);
  const item = (ch.body.items as Array<Record<string, unknown>> | undefined)?.[0];
  if (!item) return j({ error: `Channel not found for ${channelIdEnv ?? handle}` }, 404);

  const channelId = item.id as string;
  const stats = (item.statistics ?? {}) as Record<string, unknown>;
  const subs = num(stats.subscriberCount);
  const totalViews = num(stats.viewCount);
  const videoCount = num(stats.videoCount);
  const uploads = ((item.contentDetails as { relatedPlaylists?: { uploads?: string } } | undefined)?.relatedPlaylists?.uploads) ?? null;

  // 2) Engagement over the trailing 28 days = likes + comments on videos
  //    published in that window (from each video's public statistics).
  const notes: Record<string, string> = {};
  let engagement: number | null = null;
  try {
    if (uploads) {
      const pl = await getJson(`${base}/playlistItems?part=contentDetails&playlistId=${encodeURIComponent(uploads)}&maxResults=50&key=${key}`);
      if (pl.ok) {
        const cutoff = Date.now() - 28 * 86_400_000;
        const recentIds = ((pl.body.items as Array<{ contentDetails?: { videoId?: string; videoPublishedAt?: string } }> | undefined) ?? [])
          .filter(it => { const t = Date.parse(it.contentDetails?.videoPublishedAt ?? ''); return !Number.isNaN(t) && t >= cutoff; })
          .map(it => it.contentDetails?.videoId)
          .filter((v): v is string => !!v);
        if (recentIds.length) {
          const vids = await getJson(`${base}/videos?part=statistics&id=${recentIds.join(',')}&key=${key}`);
          if (vids.ok) {
            let likes = 0, comments = 0;
            for (const v of (vids.body.items as Array<{ statistics?: Record<string, unknown> }> | undefined) ?? []) {
              likes += num(v.statistics?.likeCount) ?? 0;
              comments += num(v.statistics?.commentCount) ?? 0;
            }
            engagement = likes + comments;
          } else { notes.videos = errMsg(vids.body, vids.status); }
        } else {
          engagement = 0;   // channel exists but posted nothing in the last 28 days
        }
      } else { notes.playlist = errMsg(pl.body, pl.status); }
    } else { notes.uploads = 'no uploads playlist on channel'; }
  } catch (e) { notes.engagement = (e as Error).message; }

  const asOf = new Date().toISOString().slice(0, 10);
  const now = new Date().toISOString();
  const row = {
    channel: 'youtube', as_of: asOf,
    followers: subs, reach: null, impressions: null, engagement, posts: videoCount, views: totalViews,
    raw: { channelId, handle: (item.snippet as { customUrl?: string } | undefined)?.customUrl ?? handle, statistics: stats, notes },
    synced_at: now,
  };

  const { error } = await admin.from('social_metrics').upsert([row], { onConflict: 'channel,as_of' });
  if (error) return j({ error: `DB upsert failed: ${error.message}` }, 500);

  return j({ synced: 1, channel: 'youtube', followers: subs, views: totalViews, posts: videoCount, engagement });
});

function j(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'content-type': 'application/json' },
  });
}
