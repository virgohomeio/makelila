// sync-linkedin-organic: pull organic LinkedIn company-page metrics into
// social_metrics (channel = 'linkedin') via the Community Management API. Uses
// the stored OAuth token (linkedin_oauth, captured once by linkedin-connect/
// callback); access tokens last ~60 days and refresh if a refresh token exists.
//
// Captured: followers (networkSizes firstDegreeSize), and over the trailing
// 28 days from organizationalEntityShareStatistics: reach (unique impressions),
// impressions, engagement (likes+comments+shares+clicks). LinkedIn exposes real
// impressions/reach — unlike the other networks.
//
// Secrets: LINKEDIN_CLIENT_ID, LINKEDIN_CLIENT_SECRET, LINKEDIN_ORG_ID,
// optional LINKEDIN_API_VERSION (default 202509).

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

  const clientId = Deno.env.get('LINKEDIN_CLIENT_ID');
  const clientSecret = Deno.env.get('LINKEDIN_CLIENT_SECRET');
  let orgId = Deno.env.get('LINKEDIN_ORG_ID');
  const version = Deno.env.get('LINKEDIN_API_VERSION') ?? '202509';

  const { data: tok } = await admin.from('linkedin_oauth').select('*').eq('id', 1).maybeSingle();
  if (!tok?.access_token) return j({ error: 'LinkedIn not connected — open the linkedin-connect link and authorize first.' }, 400);

  // Refresh if the access token is within a day of expiry and we have a refresh token.
  let access = tok.access_token as string;
  const expMs = tok.expires_at ? Date.parse(tok.expires_at) : 0;
  if (tok.refresh_token && clientId && clientSecret && (!expMs || expMs - Date.now() < 86_400_000)) {
    const rb = new URLSearchParams({
      grant_type: 'refresh_token', refresh_token: tok.refresh_token,
      client_id: clientId, client_secret: clientSecret,
    });
    const tr = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: rb,
    });
    const td = await tr.json().catch(() => ({})) as Record<string, unknown>;
    if (tr.ok && td.access_token) {
      access = td.access_token as string;
      await admin.from('linkedin_oauth').update({
        access_token: access,
        refresh_token: (td.refresh_token as string) ?? tok.refresh_token,
        expires_at: new Date(Date.now() + (Number(td.expires_in) || 0) * 1000).toISOString(),
        updated_at: new Date().toISOString(),
      }).eq('id', 1);
    }
  }

  const base = 'https://api.linkedin.com/rest';
  const headers = { Authorization: `Bearer ${access}`, 'LinkedIn-Version': version, 'X-Restli-Protocol-Version': '2.0.0' };
  const notes: Record<string, string> = {};

  // Auto-discover the org id from the authorizing admin's ACLs if not configured.
  if (!orgId) {
    try {
      const r = await fetch(`${base}/organizationAcls?q=roleAssignee`, { headers });
      const d = await r.json().catch(() => ({})) as { elements?: Array<{ organizationalTarget?: string; organization?: string }> };
      const target = d.elements?.[0]?.organizationalTarget ?? d.elements?.[0]?.organization;
      if (target) orgId = String(target).split(':').pop();
      else notes.org_discovery = JSON.stringify(d).slice(0, 180);
    } catch (e) { notes.org_discovery = (e as Error).message; }
  }
  if (!orgId) return j({ error: 'Could not resolve LinkedIn org id — set LINKEDIN_ORG_ID, or check the admin role on the authorized account.', notes }, 400);
  const orgUrn = `urn:li:organization:${orgId}`;

  // 1) Follower count.
  let followers: number | null = null;
  try {
    const r = await fetch(`${base}/networkSizes/${encodeURIComponent(orgUrn)}?edgeType=CompanyFollowedByMember`, { headers });
    const d = await r.json().catch(() => ({})) as { firstDegreeSize?: number };
    if (r.ok) followers = d.firstDegreeSize ?? null;
    else notes.followers = JSON.stringify(d).slice(0, 180);
  } catch (e) { notes.followers = (e as Error).message; }

  // 2) Share statistics over the trailing 28 days (daily buckets, summed).
  let reach: number | null = null, impressions: number | null = null, engagement: number | null = null;
  try {
    const end = Date.now();
    const start = end - 28 * 86_400_000;
    const url = `${base}/organizationalEntityShareStatistics?q=organizationalEntity`
      + `&organizationalEntity=${encodeURIComponent(orgUrn)}`
      + `&timeIntervals.timeRange.start=${start}&timeIntervals.timeRange.end=${end}`
      + `&timeIntervals.timeGranularityType=DAY`;
    const r = await fetch(url, { headers });
    const d = await r.json().catch(() => ({})) as { elements?: Array<{ totalShareStatistics?: Record<string, number> }> };
    if (r.ok && d.elements) {
      let imp = 0, uniq = 0, eng = 0, any = false;
      for (const el of d.elements) {
        const s = el.totalShareStatistics ?? {};
        any = true;
        imp += s.impressionCount ?? 0;
        uniq += s.uniqueImpressionsCount ?? 0;
        eng += (s.likeCount ?? 0) + (s.commentCount ?? 0) + (s.shareCount ?? 0) + (s.clickCount ?? 0);
      }
      impressions = any ? imp : 0;
      reach = any ? (uniq || null) : 0;
      engagement = any ? eng : 0;
    } else { notes.shares = JSON.stringify(d).slice(0, 220); }
  } catch (e) { notes.shares = (e as Error).message; }

  const asOf = new Date().toISOString().slice(0, 10);
  const now = new Date().toISOString();
  const row = {
    channel: 'linkedin', as_of: asOf,
    followers, reach, impressions, engagement, posts: null, views: null,
    raw: { org: orgUrn, notes }, synced_at: now,
  };
  const { error } = await admin.from('social_metrics').upsert([row], { onConflict: 'channel,as_of' });
  if (error) return j({ error: `DB upsert failed: ${error.message}` }, 500);

  return j({ synced: 1, channel: 'linkedin', followers, reach, impressions, engagement, notes });
});

function j(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'content-type': 'application/json' },
  });
}
