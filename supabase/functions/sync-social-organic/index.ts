// sync-social-organic: pull organic Facebook Page + linked Instagram metrics
// into social_metrics. Reuses the Meta token (must also carry
// pages_read_engagement, instagram_basic, instagram_manage_insights) + a Page ID.
//
// v1 pulls the stable object fields — follower counts + post counts — which
// don't churn across Graph API versions. Reach/engagement (which need the
// version-sensitive /insights metrics) are a follow-up. YouTube / LinkedIn /
// TikTok are separate functions (separate apps) and not handled here.
//
// Secrets: META_SYSTEM_USER_TOKEN, META_PAGE_ID, optional META_API_VERSION.

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

  const token = Deno.env.get('META_SYSTEM_USER_TOKEN');
  const pageId = Deno.env.get('META_PAGE_ID');
  const ver = Deno.env.get('META_API_VERSION') ?? 'v20.0';
  if (!token || !pageId) {
    return j({ error: 'Not configured: set META_SYSTEM_USER_TOKEN (with page + instagram scopes) and META_PAGE_ID in Edge Function secrets.' }, 400);
  }

  const asOf = new Date().toISOString().slice(0, 10);
  const fields = 'name,fan_count,followers_count,instagram_business_account{id,username,followers_count,media_count}';
  let body: Record<string, unknown>;
  try {
    const res = await fetch(`https://graph.facebook.com/${ver}/${pageId}?fields=${encodeURIComponent(fields)}&access_token=${encodeURIComponent(token)}`);
    body = await res.json();
    if (!res.ok) return j({ error: `Meta ${res.status}: ${JSON.stringify((body as { error?: unknown }).error ?? body).slice(0, 300)}` }, 502);
  } catch (e) {
    return j({ error: `Meta request failed: ${(e as Error).message}` }, 502);
  }

  const rows: Record<string, unknown>[] = [];
  const now = new Date().toISOString();

  // Facebook Page
  const fbFollowers = (body.followers_count as number | undefined) ?? (body.fan_count as number | undefined) ?? null;
  rows.push({
    channel: 'facebook', as_of: asOf,
    followers: fbFollowers, reach: null, impressions: null, engagement: null, posts: null, views: null,
    raw: { name: body.name, fan_count: body.fan_count, followers_count: body.followers_count }, synced_at: now,
  });

  // Linked Instagram business account
  const ig = body.instagram_business_account as
    | { id?: string; username?: string; followers_count?: number; media_count?: number }
    | undefined;
  if (ig?.id) {
    rows.push({
      channel: 'instagram', as_of: asOf,
      followers: ig.followers_count ?? null, reach: null, impressions: null, engagement: null,
      posts: ig.media_count ?? null, views: null,
      raw: ig, synced_at: now,
    });
  }

  const { error } = await admin.from('social_metrics').upsert(rows, { onConflict: 'channel,as_of' });
  if (error) return j({ error: `DB upsert failed: ${error.message}` }, 500);

  return j({ synced: rows.length, channels: rows.map(r => r.channel) });
});

function j(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'content-type': 'application/json' },
  });
}
