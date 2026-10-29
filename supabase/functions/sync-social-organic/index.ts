// sync-social-organic: pull organic Facebook Page + linked Instagram metrics
// into social_metrics. Reuses the Meta token (must carry pages_read_engagement,
// read_insights, instagram_basic, instagram_manage_insights) + a Page ID.
//
// Captures stable stock metrics (followers, post counts) AND flow metrics
// (reach / views / engagement over a trailing 28 days) via /insights.
//
// Robustness notes (Meta churns these constantly):
//  - Page insights + /published_posts need a PAGE access token, not the
//    system-user token. We mint it from the Page node's `access_token` field
//    (the system user has the Page assigned, so this is allowed).
//  - Meta retired a swathe of Page insight metrics through 2026 (e.g.
//    page_impressions_unique → page_total_media_view_unique). We try a small
//    CANDIDATE LIST per metric and keep the first that returns a number, so a
//    rename doesn't zero the column. Each call is isolated — one failure stores
//    null + a note in `raw`, never fails the whole sync (followers always land).
//  - Instagram account insights dropped `impressions` and reject `days_28` for
//    these metrics, so we aggregate `period=day` over a 28-day since/until window
//    with metric_type=total_value.
//
// YouTube / TikTok / LinkedIn are separate apps/tokens → separate functions.
//
// Secrets: META_SYSTEM_USER_TOKEN, META_PAGE_ID, optional META_API_VERSION.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { corsHeaders } from '../_shared/cors.ts';
import { authenticate } from '../_shared/auth.ts';

type InsightValue = { value: unknown };
type InsightDatum = { name: string; values?: InsightValue[]; total_value?: { value?: number } };

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: corsHeaders });

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceKey) return j({ error: 'Missing Supabase env' }, 500);
  const admin = createClient(supabaseUrl, serviceKey);

  try { await authenticate(req, admin); }
  catch (e) { if (e instanceof Response) return e; throw e; }

  const token = Deno.env.get('META_SYSTEM_USER_TOKEN');
  const pageId = Deno.env.get('META_PAGE_ID');
  const ver = Deno.env.get('META_API_VERSION') ?? 'v20.0';
  if (!token || !pageId) {
    return j({ error: 'Not configured: set META_SYSTEM_USER_TOKEN (with page + instagram scopes) and META_PAGE_ID in Edge Function secrets.' }, 400);
  }
  const base = `https://graph.facebook.com/${ver}`;
  const sysTok = encodeURIComponent(token);

  const getJson = async (url: string): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> => {
    const res = await fetch(url);
    const body = await res.json().catch(() => ({})) as Record<string, unknown>;
    return { ok: res.ok, status: res.status, body };
  };
  const errMsg = (body: Record<string, unknown>, status: number): string =>
    String((body as { error?: { message?: string } }).error?.message ?? status).slice(0, 160);
  // Last value of a period-series insight metric (trailing-28d).
  const lastValue = (data: InsightDatum[] | undefined, name: string): number | null => {
    for (const d of data ?? []) {
      if (d.name !== name) continue;
      const vals = d.values ?? [];
      const last = vals.length ? vals[vals.length - 1].value : null;
      return typeof last === 'number' ? last : null;
    }
    return null;
  };
  const totalValue = (data: InsightDatum[] | undefined, name: string): number | null => {
    for (const d of data ?? []) if (d.name === name) return typeof d.total_value?.value === 'number' ? d.total_value.value : null;
    return null;
  };

  const asOf = new Date().toISOString().slice(0, 10);
  const now = new Date().toISOString();

  // 1) Page node: followers + linked IG + the PAGE ACCESS TOKEN we need for insights.
  const fields = 'name,fan_count,followers_count,access_token,instagram_business_account{id,username,followers_count,media_count}';
  const page = await getJson(`${base}/${pageId}?fields=${encodeURIComponent(fields)}&access_token=${sysTok}`);
  if (!page.ok) {
    return j({ error: `Meta ${page.status}: ${JSON.stringify((page.body as { error?: unknown }).error ?? page.body).slice(0, 300)}` }, 502);
  }
  const body = page.body;
  const pageAccessToken = typeof body.access_token === 'string' ? body.access_token : token;
  const pageTok = encodeURIComponent(pageAccessToken);
  const notes: Record<string, string> = {};
  if (!body.access_token) notes.page_token = 'no page access_token returned — using system token (insights may fail)';

  // FB flow metric: try candidate names (Meta renames these), keep first numeric.
  const fbInsight = async (key: string, candidates: string[], period: string): Promise<number | null> => {
    let last = '';
    for (const metric of candidates) {
      try {
        const r = await getJson(`${base}/${pageId}/insights?metric=${metric}&period=${period}&access_token=${pageTok}`);
        if (r.ok) {
          const v = lastValue(r.body.data as InsightDatum[] | undefined, metric);
          if (typeof v === 'number') return v;
          last = 'no value';
        } else { last = errMsg(r.body, r.status); }
      } catch (e) { last = (e as Error).message; }
    }
    notes[key] = last;
    return null;
  };

  // 2) Facebook Page insights — reach / views / engagement over 28 days.
  const fbReach = await fbInsight('fb_reach', ['page_total_media_view_unique', 'page_impressions_unique'], 'days_28');
  const fbViews = await fbInsight('fb_views', ['page_total_media_views', 'page_impressions'], 'days_28');
  const fbEng   = await fbInsight('fb_engagement', ['page_post_engagements', 'page_total_actions'], 'days_28');

  // 3) Facebook published-post count (needs page token).
  let fbPosts: number | null = null;
  try {
    const pc = await getJson(`${base}/${pageId}/published_posts?limit=0&summary=total_count&access_token=${pageTok}`);
    if (pc.ok) {
      const total = (pc.body.summary as { total_count?: number } | undefined)?.total_count;
      fbPosts = typeof total === 'number' ? total : null;
    } else { notes.fb_posts = errMsg(pc.body, pc.status); }
  } catch (e) { notes.fb_posts = (e as Error).message; }

  const rows: Record<string, unknown>[] = [];
  const fbFollowers = (body.followers_count as number | undefined) ?? (body.fan_count as number | undefined) ?? null;
  rows.push({
    channel: 'facebook', as_of: asOf,
    followers: fbFollowers, reach: fbReach, impressions: fbViews, engagement: fbEng, posts: fbPosts, views: fbViews,
    raw: { name: body.name, fan_count: body.fan_count, followers_count: body.followers_count, notes }, synced_at: now,
  });

  // 4) Instagram — followers/media (stable) + reach/engagement (28d via since/until).
  const ig = body.instagram_business_account as
    | { id?: string; username?: string; followers_count?: number; media_count?: number }
    | undefined;
  if (ig?.id) {
    const igNotes: Record<string, string> = {};
    const until = Math.floor(Date.now() / 1000);
    const since = until - 28 * 86400;
    const igInsight = async (metric: string): Promise<number | null> => {
      try {
        const r = await getJson(`${base}/${ig.id}/insights?metric=${metric}&period=day&metric_type=total_value&since=${since}&until=${until}&access_token=${pageTok}`);
        if (r.ok) return totalValue(r.body.data as InsightDatum[] | undefined, metric);
        igNotes[metric] = errMsg(r.body, r.status);
      } catch (e) { igNotes[metric] = (e as Error).message; }
      return null;
    };
    const igReach = await igInsight('reach');
    const igEng = await igInsight('total_interactions');
    rows.push({
      channel: 'instagram', as_of: asOf,
      followers: ig.followers_count ?? null, reach: igReach, impressions: null, engagement: igEng,
      posts: ig.media_count ?? null, views: null,
      raw: { ...ig, notes: igNotes }, synced_at: now,
    });
  }

  const { error } = await admin.from('social_metrics').upsert(rows, { onConflict: 'channel,as_of' });
  if (error) return j({ error: `DB upsert failed: ${error.message}` }, 500);

  return j({
    synced: rows.length,
    channels: rows.map(r => ({ channel: r.channel, followers: r.followers, reach: r.reach, engagement: r.engagement, posts: r.posts })),
  });
});

function j(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'content-type': 'application/json' },
  });
}
