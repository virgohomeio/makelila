// sync-tiktok-organic: pull organic TikTok metrics into social_metrics
// (channel = 'tiktok') via the Display API. Uses the stored OAuth refresh token
// (tiktok_oauth, captured once by tiktok-connect/callback); access tokens only
// last 24h so we refresh on every run and persist the rotated tokens.
//
// Captured: followers = follower_count, posts = video_count, engagement =
// likes+comments+shares on videos posted in the trailing 28 days, views = those
// videos' view counts. Reach isn't exposed by the Display API → null.
//
// Secrets: TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET.

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

  const clientKey = Deno.env.get('TIKTOK_CLIENT_KEY');
  const clientSecret = Deno.env.get('TIKTOK_CLIENT_SECRET');
  if (!clientKey || !clientSecret) return j({ error: 'Not configured: set TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET.' }, 400);

  const { data: tok } = await admin.from('tiktok_oauth').select('*').eq('id', 1).maybeSingle();
  if (!tok?.refresh_token) return j({ error: 'TikTok not connected — open the tiktok-connect link and authorize first.' }, 400);

  // Refresh the (24h) access token; the refresh token may rotate, so persist both.
  const rb = new URLSearchParams({
    client_key: clientKey, client_secret: clientSecret,
    grant_type: 'refresh_token', refresh_token: tok.refresh_token,
  });
  const tr = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: rb,
  });
  const td = await tr.json().catch(() => ({})) as Record<string, unknown>;
  if (!tr.ok || td.error || !td.access_token) {
    return j({ error: `TikTok token refresh failed: ${JSON.stringify(td.error ?? td).slice(0, 300)}` }, 502);
  }
  const access = td.access_token as string;
  await admin.from('tiktok_oauth').update({
    access_token: access,
    refresh_token: (td.refresh_token as string) ?? tok.refresh_token,
    expires_at: new Date(Date.now() + (Number(td.expires_in) || 0) * 1000).toISOString(),
    scope: (td.scope as string) ?? tok.scope,
    updated_at: new Date().toISOString(),
  }).eq('id', 1);

  const notes: Record<string, string> = {};
  const auth = { Authorization: `Bearer ${access}` };

  // 1) Account stats.
  const uiFields = 'open_id,display_name,follower_count,following_count,likes_count,video_count';
  const ui = await fetch(`https://open.tiktokapis.com/v2/user/info/?fields=${uiFields}`, { headers: auth });
  const uid = await ui.json().catch(() => ({})) as { data?: { user?: Record<string, unknown> }; error?: { code?: string; message?: string } };
  if (!ui.ok || (uid.error?.code && uid.error.code !== 'ok')) {
    return j({ error: `TikTok user/info failed: ${JSON.stringify(uid.error ?? uid).slice(0, 300)}` }, 502);
  }
  const user = uid.data?.user ?? {};
  const followers = (user.follower_count as number | undefined) ?? null;
  const videoCount = (user.video_count as number | undefined) ?? null;

  // 2) Recent videos → trailing-28d engagement + views.
  let engagement: number | null = null;
  let views: number | null = null;
  try {
    const vlFields = 'id,create_time,like_count,comment_count,share_count,view_count';
    const vl = await fetch(`https://open.tiktokapis.com/v2/video/list/?fields=${vlFields}`, {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ max_count: 20 }),
    });
    const vld = await vl.json().catch(() => ({})) as { data?: { videos?: Array<Record<string, number>> }; error?: { code?: string } };
    if (vl.ok && vld.data?.videos) {
      const cutoff = Math.floor((Date.now() - 28 * 86_400_000) / 1000);
      let eng = 0, vw = 0, any = false;
      for (const v of vld.data.videos) {
        if ((v.create_time ?? 0) < cutoff) continue;
        any = true;
        eng += (v.like_count ?? 0) + (v.comment_count ?? 0) + (v.share_count ?? 0);
        vw += v.view_count ?? 0;
      }
      engagement = any ? eng : 0;
      views = any ? vw : 0;
    } else { notes.videos = JSON.stringify(vld.error ?? vld).slice(0, 160); }
  } catch (e) { notes.videos = (e as Error).message; }

  const asOf = new Date().toISOString().slice(0, 10);
  const now = new Date().toISOString();
  const row = {
    channel: 'tiktok', as_of: asOf,
    followers, reach: null, impressions: null, engagement, posts: videoCount, views,
    raw: {
      display_name: user.display_name, likes_count: user.likes_count,
      following_count: user.following_count, open_id: user.open_id, notes,
    },
    synced_at: now,
  };
  const { error } = await admin.from('social_metrics').upsert([row], { onConflict: 'channel,as_of' });
  if (error) return j({ error: `DB upsert failed: ${error.message}` }, 500);

  return j({ synced: 1, channel: 'tiktok', followers, posts: videoCount, engagement, views });
});

function j(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'content-type': 'application/json' },
  });
}
