// sync-google-ads: pull Google Ads campaign metrics into google_ads_campaigns
// (one row per campaign per day), the Google counterpart to sync-facebook-ads.
// Powers the Marketing module's Google section + the CAC table (Google spend
// kept clearly separate from Meta).
//
// Operator-triggered (user JWT) + cron-safe (x-cron-secret), same as the Meta
// sync.
//
// Auth: reuses the SAME Google service account as the GA4 / Search Console pulls
// (GOOGLE_SERVICE_ACCOUNT_JSON), minting a token for the `adwords` scope. The
// service account's email must be added as a user on the Google Ads account
// (Google Ads → Admin → Access and security → Users). Developer tokens were
// sunset by Google (Sep 2026) and are not used.
//
// Secrets:
//   GOOGLE_SERVICE_ACCOUNT_JSON    (already set — shared with GA4/Search Console)
//   GOOGLE_ADS_CUSTOMER_ID         the ad account to pull (digits; dashes stripped)
//   GOOGLE_ADS_LOGIN_CUSTOMER_ID   optional — the MCC/manager id, if the account
//                                  is reached through a manager (digits)
//   GOOGLE_ADS_API_VERSION         optional — defaults to v26 (bump as Google releases)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { corsHeaders } from '../_shared/cors.ts';
import { authenticate } from '../_shared/auth.ts';
import { getGoogleAccessToken, type ServiceAccount } from '../_shared/google-auth.ts';

const ADWORDS_SCOPE = 'https://www.googleapis.com/auth/adwords';

type GaRow = {
  campaign?: { id?: string; name?: string; status?: string };
  metrics?: {
    costMicros?: string; impressions?: string; clicks?: string;
    conversions?: number; conversionsValue?: number;
  };
  segments?: { date?: string };
  customer?: { currencyCode?: string };
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

  const saJson = Deno.env.get('GOOGLE_SERVICE_ACCOUNT_JSON');
  const rawCustomer = Deno.env.get('GOOGLE_ADS_CUSTOMER_ID');
  const loginCustomer = (Deno.env.get('GOOGLE_ADS_LOGIN_CUSTOMER_ID') ?? '').replace(/\D/g, '');
  const version = Deno.env.get('GOOGLE_ADS_API_VERSION') ?? 'v26';
  if (!saJson) return j({ error: 'GOOGLE_SERVICE_ACCOUNT_JSON not configured (shared with GA4).' }, 400);
  if (!rawCustomer) return j({ error: 'GOOGLE_ADS_CUSTOMER_ID not configured in Edge Function secrets.' }, 400);
  const customerId = rawCustomer.replace(/\D/g, '');

  // 1) Service-account access token for the Ads API (same SA as GA4).
  let accessToken: string;
  try {
    const sa = JSON.parse(saJson) as ServiceAccount;
    accessToken = await getGoogleAccessToken(sa, [ADWORDS_SCOPE]);
  } catch (e) {
    return j({ error: `Service-account token failed: ${(e as Error).message}` }, 502);
  }

  // 2) Campaign metrics, one row per campaign per day. GAQL has no LAST_90_DAYS
  //    literal (only up to LAST_30_DAYS), so use an explicit 90-day BETWEEN range.
  const until = new Date();
  const since = new Date(); since.setDate(since.getDate() - 90);
  const day = (d: Date) => d.toISOString().slice(0, 10);
  const query = `
    SELECT campaign.id, campaign.name, campaign.status,
           metrics.cost_micros, metrics.impressions, metrics.clicks,
           metrics.conversions, metrics.conversions_value,
           customer.currency_code, segments.date
    FROM campaign
    WHERE segments.date BETWEEN '${day(since)}' AND '${day(until)}'`;

  const headers: Record<string, string> = {
    'Authorization': `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  };
  if (loginCustomer) headers['login-customer-id'] = loginCustomer;

  const rows: Record<string, unknown>[] = [];
  const now = new Date().toISOString();
  try {
    const url = `https://googleads.googleapis.com/${version}/customers/${customerId}/googleAds:searchStream`;
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ query }) });
    const body = await res.json();
    if (!res.ok) return j({ error: `Google Ads ${res.status}: ${JSON.stringify(body).slice(0, 400)}` }, 502);
    // searchStream returns an array of batches, each with a `results` array.
    const batches = (Array.isArray(body) ? body : [body]) as Array<{ results?: GaRow[] }>;
    for (const batch of batches) {
      for (const r of batch.results ?? []) {
        const id = r.campaign?.id;
        const date = r.segments?.date;
        if (!id || !date) continue;
        const n = (v?: string) => (v != null && v !== '' ? Number(v) : null);
        rows.push({
          campaign_id: id,
          campaign_name: r.campaign?.name ?? id,
          status: r.campaign?.status ?? null,
          date,
          spend: r.metrics?.costMicros != null ? Number(r.metrics.costMicros) / 1_000_000 : null,
          currency: r.customer?.currencyCode ?? null,
          impressions: n(r.metrics?.impressions),
          clicks: n(r.metrics?.clicks),
          conversions: r.metrics?.conversions ?? null,
          conversions_value: r.metrics?.conversionsValue ?? null,
          metrics: r.metrics ?? null,
          synced_at: now,
        });
      }
    }
  } catch (e) {
    return j({ error: `Google Ads request failed: ${(e as Error).message}` }, 502);
  }

  if (rows.length === 0) return j({ synced: 0, note: 'No Google Ads rows returned for the window.' });

  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await admin.from('google_ads_campaigns').upsert(rows.slice(i, i + 500), { onConflict: 'campaign_id,date' });
    if (error) return j({ error: `DB upsert failed: ${error.message}` }, 500);
  }

  return j({ synced: rows.length });
});

function j(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'content-type': 'application/json' },
  });
}
