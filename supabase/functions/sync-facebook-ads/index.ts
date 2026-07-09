// sync-facebook-ads: pull Meta (Facebook) ad-campaign metrics into fb_campaigns.
//
// Powers the Marketing module's Campaigns tab (full Ads-Manager column set) +
// Dashboard. Operator-triggered (user JWT) + cron-safe (x-cron-secret). Pulls
// campaign metadata (budget / bid strategy / dates / delivery) + lifetime
// campaign-level insights (spend, reach, cpm, ctr, frequency + the full actions
// breakdown: adds to cart, purchases, video plays, post engagement, etc.) and
// upserts on (campaign_id, date_start). The rich column set lives in the
// `metrics` jsonb; spend_cad/impressions/clicks/leads/reach stay as columns for
// the dashboard/report aggregations.
//
// Secrets: META_SYSTEM_USER_TOKEN (ads_read), META_AD_ACCOUNT_ID (act_<digits>),
// optional META_API_VERSION (default v20.0).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { corsHeaders } from '../_shared/cors.ts';
import { authenticate } from '../_shared/auth.ts';

type ActionItem = { action_type: string; value: string };
type Insight = {
  campaign_id?: string;
  campaign_name?: string;
  spend?: string;
  impressions?: string;
  clicks?: string;
  ctr?: string;
  cpm?: string;
  reach?: string;
  frequency?: string;
  inline_link_clicks?: string;
  date_start?: string;
  date_stop?: string;
  actions?: ActionItem[];
  video_p75_watched_actions?: ActionItem[];
  video_p100_watched_actions?: ActionItem[];
};
type CampaignMeta = {
  id: string; name?: string; status?: string; effective_status?: string; objective?: string;
  daily_budget?: string; lifetime_budget?: string; bid_strategy?: string;
  start_time?: string; stop_time?: string;
};

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
  const rawAcct = Deno.env.get('META_AD_ACCOUNT_ID');
  const ver = Deno.env.get('META_API_VERSION') ?? 'v20.0';
  if (!token || !rawAcct) {
    return j({ error: 'Meta not configured: set META_SYSTEM_USER_TOKEN and META_AD_ACCOUNT_ID in Edge Function secrets.' }, 400);
  }
  const acct = rawAcct.startsWith('act_') ? rawAcct : `act_${rawAcct.replace(/\D/g, '')}`;
  const base = `https://graph.facebook.com/${ver}`;

  // 1) Campaign metadata (budget / bid strategy / dates / delivery aren't on insights).
  const metaById = new Map<string, CampaignMeta>();
  try {
    let url: string | null =
      `${base}/${acct}/campaigns?fields=id,name,status,effective_status,objective,daily_budget,lifetime_budget,bid_strategy,start_time,stop_time&limit=500&access_token=${encodeURIComponent(token)}`;
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

  // 2) Lifetime campaign-level insights (one row per campaign).
  const fields = [
    'campaign_id', 'campaign_name', 'spend', 'impressions', 'clicks', 'ctr', 'cpm',
    'reach', 'frequency', 'inline_link_clicks', 'actions',
    'video_p75_watched_actions', 'video_p100_watched_actions', 'date_start', 'date_stop',
  ].join(',');

  const rows: Record<string, unknown>[] = [];
  const now = new Date().toISOString();
  try {
    let url: string | null =
      `${base}/${acct}/insights?level=campaign&fields=${fields}&date_preset=maximum&limit=500&access_token=${encodeURIComponent(token)}`;
    let pages = 0;
    while (url && pages < 20) {
      const res = await fetch(url);
      const body = await res.json();
      if (!res.ok) return j({ error: `Meta insights ${res.status}: ${JSON.stringify(body?.error ?? body).slice(0, 300)}` }, 502);
      for (const ins of (body.data ?? []) as Insight[]) {
        if (!ins.campaign_id || !ins.date_start) continue;
        rows.push(buildRow(ins, metaById.get(ins.campaign_id), now));
      }
      url = body.paging?.next ?? null;
      pages++;
    }
  } catch (e) {
    return j({ error: `Meta insights request failed: ${(e as Error).message}` }, 502);
  }

  if (rows.length === 0) {
    return j({ synced: 0, note: 'No campaign insights returned (no spend, or the token cannot see this ad account).' });
  }

  const { error } = await admin.from('fb_campaigns').upsert(rows, { onConflict: 'campaign_id,date_start' });
  if (error) return j({ error: `DB upsert failed: ${error.message}` }, 500);

  // 3) Ad-level insights → fb_ads (for per-ad-set + per-creative analysis, e.g.
  //    the LILA Mini test: 5 creatives × 5 audiences). Non-fatal — the campaign
  //    data is already saved if this part errors.
  const adRows: Record<string, unknown>[] = [];
  try {
    const adFields = 'campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,spend,impressions,clicks,ctr,actions,date_start,date_stop';
    let url: string | null =
      `${base}/${acct}/insights?level=ad&fields=${adFields}&date_preset=maximum&limit=500&access_token=${encodeURIComponent(token)}`;
    let pages = 0;
    const n = (v?: string) => (v != null && v !== '' ? Number(v) : null);
    while (url && pages < 40) {
      const res = await fetch(url);
      const body = await res.json();
      if (!res.ok) break;
      for (const a of (body.data ?? []) as Array<Record<string, unknown> & { actions?: ActionItem[] }>) {
        if (!a.ad_id || !a.date_start) continue;
        adRows.push({
          ad_id: a.ad_id,
          ad_name: a.ad_name ?? a.ad_id,
          adset_id: a.adset_id ?? null,
          adset_name: a.adset_name ?? null,
          campaign_id: a.campaign_id ?? null,
          campaign_name: a.campaign_name ?? null,
          date_start: a.date_start,
          date_stop: a.date_stop ?? a.date_start,
          spend_cad: n(a.spend as string | undefined),
          impressions: n(a.impressions as string | undefined),
          clicks: n(a.clicks as string | undefined),
          ctr: n(a.ctr as string | undefined),
          leads: actionVal(a.actions, ['offsite_conversion.fb_pixel_lead', 'lead', 'onsite_conversion.lead_grouped']),
          synced_at: now,
        });
      }
      url = body.paging?.next ?? null;
      pages++;
    }
    if (adRows.length) {
      await admin.from('fb_ads').upsert(adRows, { onConflict: 'ad_id,date_start' });
    }
  } catch { /* non-fatal — campaign sync already succeeded */ }

  return j({ synced: rows.length, ads: adRows.length });
});

function buildRow(ins: Insight, meta: CampaignMeta | undefined, now: string): Record<string, unknown> {
  const A = ins.actions;
  const num = (v?: string) => (v != null && v !== '' ? Number(v) : null);

  const spend = num(ins.spend);
  const impressions = num(ins.impressions);
  const reach = num(ins.reach);
  const clicks = num(ins.clicks);

  const adds_to_cart        = actionVal(A, ['offsite_conversion.fb_pixel_add_to_cart', 'add_to_cart', 'omni_add_to_cart']);
  const add_payment_info    = actionVal(A, ['offsite_conversion.fb_pixel_add_payment_info', 'add_payment_info']);
  const checkouts_initiated = actionVal(A, ['offsite_conversion.fb_pixel_initiate_checkout', 'initiate_checkout', 'omni_initiated_checkout']);
  const website_purchases   = actionVal(A, ['offsite_conversion.fb_pixel_purchase', 'purchase', 'omni_purchase']);
  const leads               = actionVal(A, ['offsite_conversion.fb_pixel_lead', 'lead', 'onsite_conversion.lead_grouped']);
  const link_clicks         = ins.inline_link_clicks != null ? Number(ins.inline_link_clicks) : actionVal(A, ['link_click']);
  const landing_page_views  = actionVal(A, ['landing_page_view']);
  const post_comments       = actionVal(A, ['comment']);
  const post_reactions      = actionVal(A, ['post_reaction']);
  const post_shares         = actionVal(A, ['post']);
  const page_likes          = actionVal(A, ['like']);
  const post_saves          = actionVal(A, ['onsite_conversion.post_save']);
  const video_3s            = actionVal(A, ['video_view']);
  const video_p75           = sumActions(ins.video_p75_watched_actions);
  const video_p100          = sumActions(ins.video_p100_watched_actions);

  // Results / cost-per-result / result-rate keyed off the campaign objective.
  const obj = (meta?.objective ?? '').toUpperCase();
  let results: number | null;
  let resultLabel: string;
  if (obj.includes('LEAD')) { results = leads; resultLabel = 'Leads'; }
  else if (obj.includes('SALE') || obj.includes('CONVERSION') || obj.includes('PURCHASE')) { results = website_purchases; resultLabel = 'Purchases'; }
  else if (obj.includes('TRAFFIC') || obj.includes('LINK_CLICK')) { results = link_clicks; resultLabel = 'Link clicks'; }
  else if (obj.includes('ENGAGEMENT')) { results = actionVal(A, ['post_engagement']); resultLabel = 'Engagements'; }
  else if (obj.includes('AWARENESS') || obj.includes('REACH')) { results = reach; resultLabel = 'Reach'; }
  else if (obj.includes('VIDEO')) { results = video_3s; resultLabel = 'Video plays'; }
  else { results = leads || website_purchases || link_clicks || null; resultLabel = 'Results'; }
  const cost_per_result = results && spend != null && results > 0 ? +(spend / results).toFixed(2) : null;
  const result_rate = results != null && impressions ? +((results / impressions) * 100).toFixed(2) : null;

  // Budget: daily/lifetime are strings in cents (account currency). '0'/null →
  // the campaign uses ad-set budgets.
  const daily = meta?.daily_budget && Number(meta.daily_budget) > 0 ? Number(meta.daily_budget) / 100 : null;
  const lifetime = meta?.lifetime_budget && Number(meta.lifetime_budget) > 0 ? Number(meta.lifetime_budget) / 100 : null;
  const budget = daily ? `$${daily.toFixed(0)}/day` : lifetime ? `$${lifetime.toFixed(0)} lifetime` : 'Using ad set budget';

  const metrics = {
    delivery: deliveryLabel(meta?.effective_status ?? meta?.status),
    budget,
    results, result_label: resultLabel, cost_per_result, result_rate,
    adds_to_cart, add_payment_info, checkouts_initiated,
    ctr: num(ins.ctr), cpm: num(ins.cpm), reach, frequency: num(ins.frequency),
    leads, link_clicks, landing_page_views,
    post_comments, post_reactions, post_shares, page_likes, post_saves,
    website_purchases,
    bid_strategy: meta?.bid_strategy ?? null,
    campaign_start: meta?.start_time ? meta.start_time.slice(0, 10) : null,
    campaign_end: meta?.stop_time ? meta.stop_time.slice(0, 10) : 'Ongoing',
    attribution_setting: null,   // account default; not reliably per-campaign
    video_3s, video_p75, video_p100,
  };

  return {
    campaign_id: ins.campaign_id,
    campaign_name: ins.campaign_name ?? meta?.name ?? ins.campaign_id,
    status: meta?.status ?? 'UNKNOWN',
    objective: meta?.objective ?? null,
    date_start: ins.date_start,
    date_stop: ins.date_stop ?? ins.date_start,
    spend_cad: spend,
    impressions,
    clicks,
    leads,
    reach,
    metrics,
    raw: ins,
    synced_at: now,
  };
}

function actionVal(actions: ActionItem[] | undefined, keys: string[]): number {
  if (!actions) return 0;
  for (const k of keys) {
    const found = actions.find(a => a.action_type === k);
    if (found) return Number(found.value) || 0;
  }
  return 0;
}

function sumActions(arr: ActionItem[] | undefined): number {
  if (!arr) return 0;
  return arr.reduce((s, a) => s + (Number(a.value) || 0), 0);
}

function deliveryLabel(s: string | undefined): string {
  if (!s) return '—';
  const m: Record<string, string> = {
    ACTIVE: 'Active', PAUSED: 'Off', CAMPAIGN_PAUSED: 'Off', ADSET_PAUSED: 'Off',
    ARCHIVED: 'Archived', DELETED: 'Deleted', IN_PROCESS: 'In review', WITH_ISSUES: 'Issues',
  };
  return m[s] ?? s;
}

function j(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'content-type': 'application/json' },
  });
}
