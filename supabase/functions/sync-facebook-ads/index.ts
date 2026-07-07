// sync-facebook-ads: pull Meta (Facebook) ad-campaign metrics into fb_campaigns.
//
// Powers the Marketing module's Campaigns tab + Dashboard. Operator-triggered
// from the "Sync Facebook Ads" button (user JWT) and safe to also run on a cron
// (x-cron-secret). Reads campaign-level insights (spend / impressions / clicks /
// leads) for the last 90 days and upserts on (campaign_id, date_start).
//
// Secrets (set in Supabase → Edge Functions → Secrets):
//   META_SYSTEM_USER_TOKEN  — a Meta token with ads_read (system-user "Never"
//                             token recommended for the durable cron).
//   META_AD_ACCOUNT_ID      — the ad account, "act_<digits>" (bare digits ok).
//   META_API_VERSION        — optional, defaults to v20.0.
//
// When the secrets aren't set yet it returns a clear 400 instead of throwing,
// so the UI shows a helpful message rather than a generic failure.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { corsHeaders } from '../_shared/cors.ts';
import { authenticate } from '../_shared/auth.ts';

type Insight = {
  campaign_id?: string;
  campaign_name?: string;
  spend?: string;
  impressions?: string;
  clicks?: string;
  date_start?: string;
  date_stop?: string;
  actions?: Array<{ action_type: string; value: string }>;
};

type CampaignMeta = { id: string; name?: string; status?: string; objective?: string };

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: corsHeaders });

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceKey) return j({ error: 'Missing Supabase env' }, 500);
  const admin = createClient(supabaseUrl, serviceKey);

  // Operator JWT or cron-secret both allowed (button + future nightly cron).
  try { await authenticate(req, admin); }
  catch (e) { if (e instanceof Response) return e; throw e; }

  const token = Deno.env.get('META_SYSTEM_USER_TOKEN');
  const rawAcct = Deno.env.get('META_AD_ACCOUNT_ID');
  const ver = Deno.env.get('META_API_VERSION') ?? 'v20.0';
  if (!token || !rawAcct) {
    return j({ error: 'Meta not configured: set META_SYSTEM_USER_TOKEN and META_AD_ACCOUNT_ID in Edge Function secrets.' }, 400);
  }
  const acct = rawAcct.startsWith('act_') ? rawAcct : `act_${rawAcct.replace(/\D/g, '')}`;
  const base = `https://graph.facebook.com/${ver}`;

  // 1) Campaign metadata (status/objective aren't on insights).
  const metaById = new Map<string, CampaignMeta>();
  try {
    let url: string | null =
      `${base}/${acct}/campaigns?fields=id,name,status,objective&limit=200&access_token=${encodeURIComponent(token)}`;
    let pages = 0;
    while (url && pages < 10) {
      const res = await fetch(url);
      const body = await res.json();
      if (!res.ok) return j({ error: `Meta campaigns ${res.status}: ${JSON.stringify(body?.error ?? body).slice(0, 300)}` }, 502);
      for (const c of (body.data ?? []) as CampaignMeta[]) metaById.set(c.id, c);
      url = body.paging?.next ?? null;
      pages++;
    }
  } catch (e) {
    return j({ error: `Meta campaigns request failed: ${(e as Error).message}` }, 502);
  }

  // 2) Campaign-level insights for the last 90 days (one row per campaign).
  const rows: Record<string, unknown>[] = [];
  const now = new Date().toISOString();
  try {
    let url: string | null =
      `${base}/${acct}/insights?level=campaign&fields=campaign_id,campaign_name,spend,impressions,clicks,actions,date_start,date_stop&date_preset=last_90d&limit=200&access_token=${encodeURIComponent(token)}`;
    let pages = 0;
    while (url && pages < 20) {
      const res = await fetch(url);
      const body = await res.json();
      if (!res.ok) return j({ error: `Meta insights ${res.status}: ${JSON.stringify(body?.error ?? body).slice(0, 300)}` }, 502);
      for (const ins of (body.data ?? []) as Insight[]) {
        if (!ins.campaign_id || !ins.date_start) continue;
        const meta = metaById.get(ins.campaign_id);
        const spend = ins.spend != null ? Number(ins.spend) : null;
        const leads = sumLeads(ins.actions);
        rows.push({
          campaign_id: ins.campaign_id,
          campaign_name: ins.campaign_name ?? meta?.name ?? ins.campaign_id,
          status: meta?.status ?? 'UNKNOWN',
          objective: meta?.objective ?? null,
          date_start: ins.date_start,
          date_stop: ins.date_stop ?? ins.date_start,
          spend_cad: spend,
          impressions: ins.impressions != null ? Number(ins.impressions) : null,
          clicks: ins.clicks != null ? Number(ins.clicks) : null,
          leads,
          // cpl_cad is a generated column (spend / leads) — the DB computes it,
          // so we must NOT send a value or the upsert is rejected.
          synced_at: now,
        });
      }
      url = body.paging?.next ?? null;
      pages++;
    }
  } catch (e) {
    return j({ error: `Meta insights request failed: ${(e as Error).message}` }, 502);
  }

  if (rows.length === 0) {
    return j({ synced: 0, note: 'No campaign insights returned for the last 90 days (no spend, or the token cannot see this ad account).' });
  }

  const { error } = await admin.from('fb_campaigns').upsert(rows, { onConflict: 'campaign_id,date_start' });
  if (error) return j({ error: `DB upsert failed: ${error.message}` }, 500);

  return j({ synced: rows.length });
});

function sumLeads(actions?: Array<{ action_type: string; value: string }>): number {
  if (!actions) return 0;
  let n = 0;
  for (const a of actions) {
    if (a.action_type.includes('lead')) n += Number(a.value) || 0;
  }
  return n;
}

function j(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'content-type': 'application/json' },
  });
}
