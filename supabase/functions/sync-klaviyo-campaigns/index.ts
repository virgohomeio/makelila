// sync-klaviyo-campaigns: pull email campaign performance into klaviyo_campaigns
// for the Marketing → Email tab. Two Klaviyo calls:
//   1. GET /api/campaigns  — names, status, send_time (email channel)
//   2. POST /api/campaign-values-reports — per-campaign stats (opens, clicks,
//      rates, revenue) over the last year, keyed to the "Placed Order" metric.
//
// Account-level — does NOT depend on per-customer klaviyo_profile_id (that's the
// journey leg). Operator-triggered + cron-safe.
//
// Secret: KLAVIYO_PRIVATE_KEY (Full Access, or scopes: Campaigns:Read,
// Metrics:Read, and reporting). Same key the other klaviyo functions use.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { corsHeaders } from '../_shared/cors.ts';
import { authenticate } from '../_shared/auth.ts';

const KLAVIYO_KEY = Deno.env.get('KLAVIYO_PRIVATE_KEY') ?? '';
const KLAVIYO_REV = '2024-10-15';

function kHeaders(): Record<string, string> {
  return {
    'Authorization': `Klaviyo-API-Key ${KLAVIYO_KEY}`,
    'revision': KLAVIYO_REV,
    'Accept': 'application/json',
    'Content-Type': 'application/json',
  };
}

type Grouping = { campaign_id?: string };
type ReportResult = { groupings?: Grouping; statistics?: Record<string, number> };

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: corsHeaders });

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceKey) return j({ error: 'Missing Supabase env' }, 500);
  const admin = createClient(supabaseUrl, serviceKey);

  try { await authenticate(req, admin); }
  catch (e) { if (e instanceof Response) return e; throw e; }

  if (!KLAVIYO_KEY) return j({ error: 'KLAVIYO_PRIVATE_KEY not configured' }, 400);

  // 1. Find the conversion metric ("Placed Order" from the Shopify integration).
  //    The campaign-values report requires a conversion_metric_id. The Metrics
  //    endpoint has no page[size] param — page via links.next.
  let conversionMetricId = '';
  try {
    const metrics: Array<{ id: string; attributes?: { name?: string } }> = [];
    let mUrl: string | null = 'https://a.klaviyo.com/api/metrics/';
    let mPages = 0;
    while (mUrl && mPages < 10) {
      const res = await fetch(mUrl, { headers: kHeaders() });
      if (!res.ok) return j({ error: `Klaviyo metrics ${res.status}: ${(await res.text()).slice(0, 300)}` }, 502);
      const body = await res.json() as {
        data?: Array<{ id: string; attributes?: { name?: string } }>;
        links?: { next?: string | null };
      };
      for (const m of body.data ?? []) metrics.push(m);
      mUrl = body.links?.next ?? null;
      mPages++;
    }
    const pick = (n: string) => metrics.find(m => (m.attributes?.name ?? '').toLowerCase() === n)?.id;
    conversionMetricId = pick('placed order') ?? pick('ordered product') ??
      metrics.find(m => /order/i.test(m.attributes?.name ?? ''))?.id ?? '';
    if (!conversionMetricId) return j({ error: 'No "Placed Order" metric found in Klaviyo (connect Shopify, or no order events yet).' }, 400);
  } catch (e) {
    return j({ error: `Klaviyo metrics request failed: ${(e as Error).message}` }, 502);
  }

  // 2. Campaign names/status/send_time (email channel). Page through.
  const meta = new Map<string, { name?: string; status?: string; send_time?: string }>();
  try {
    let url: string | null =
      'https://a.klaviyo.com/api/campaigns/?filter=' +
      encodeURIComponent("equals(messages.channel,'email')") +
      '&fields%5Bcampaign%5D=name,status,send_time&sort=-created_at';
    let pages = 0;
    while (url && pages < 20) {
      const res = await fetch(url, { headers: kHeaders() });
      if (!res.ok) return j({ error: `Klaviyo campaigns ${res.status}: ${(await res.text()).slice(0, 300)}` }, 502);
      const body = await res.json() as {
        data?: Array<{ id: string; attributes?: { name?: string; status?: string; send_time?: string } }>;
        links?: { next?: string | null };
      };
      for (const c of body.data ?? []) {
        meta.set(c.id, { name: c.attributes?.name, status: c.attributes?.status, send_time: c.attributes?.send_time });
      }
      url = body.links?.next ?? null;
      pages++;
    }
  } catch (e) {
    return j({ error: `Klaviyo campaigns request failed: ${(e as Error).message}` }, 502);
  }

  // 3. Per-campaign stats over the last year. Use an explicit rolling window
  //    (now − 365d → now) instead of the `last_12_months` key, which is
  //    calendar-month based and drops campaigns sent in the current month.
  const statistics = [
    'recipients', 'delivered', 'opens_unique', 'open_rate', 'clicks_unique', 'click_rate',
    'conversions', 'conversion_value', 'unsubscribes', 'unsubscribe_rate', 'bounce_rate', 'spam_complaint_rate',
  ];
  const end = new Date();
  const start = new Date(end.getTime() - 365 * 86_400_000);
  let results: ReportResult[] = [];
  try {
    const res = await fetch('https://a.klaviyo.com/api/campaign-values-reports/', {
      method: 'POST',
      headers: kHeaders(),
      body: JSON.stringify({
        data: {
          type: 'campaign-values-report',
          attributes: {
            timeframe: { start: start.toISOString(), end: end.toISOString() },
            conversion_metric_id: conversionMetricId,
            statistics,
          },
        },
      }),
    });
    if (!res.ok) return j({ error: `Klaviyo report ${res.status}: ${(await res.text()).slice(0, 400)}` }, 502);
    const body = await res.json() as { data?: { attributes?: { results?: ReportResult[] } } };
    results = body.data?.attributes?.results ?? [];
  } catch (e) {
    return j({ error: `Klaviyo report request failed: ${(e as Error).message}` }, 502);
  }

  const now = new Date().toISOString();
  const rows = results
    .filter(r => r.groupings?.campaign_id)
    .map(r => {
      const id = r.groupings!.campaign_id!;
      const s = r.statistics ?? {};
      const m = meta.get(id) ?? {};
      return {
        campaign_id: id,
        name: m.name ?? null,
        status: m.status ?? null,
        channel: 'email',
        send_time: m.send_time ?? null,
        recipients: intOr(s.recipients),
        delivered: intOr(s.delivered),
        opens_unique: intOr(s.opens_unique),
        open_rate: numOr(s.open_rate),
        clicks_unique: intOr(s.clicks_unique),
        click_rate: numOr(s.click_rate),
        conversions: intOr(s.conversions),
        revenue: numOr(s.conversion_value),
        unsubscribes: intOr(s.unsubscribes),
        unsubscribe_rate: numOr(s.unsubscribe_rate),
        bounce_rate: numOr(s.bounce_rate),
        spam_complaint_rate: numOr(s.spam_complaint_rate),
        raw: { groupings: r.groupings, statistics: s },
        synced_at: now,
      };
    });

  if (rows.length === 0) return j({ synced: 0, note: 'No campaign data returned for the last 12 months.' });

  const { error } = await admin.from('klaviyo_campaigns').upsert(rows, { onConflict: 'campaign_id' });
  if (error) return j({ error: `DB upsert failed: ${error.message}` }, 500);

  return j({ synced: rows.length });
});

function intOr(v: unknown): number | null { return typeof v === 'number' && isFinite(v) ? Math.round(v) : null; }
function numOr(v: unknown): number | null { return typeof v === 'number' && isFinite(v) ? v : null; }

function j(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'content-type': 'application/json' },
  });
}
