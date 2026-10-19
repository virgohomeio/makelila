// sync-google-ads: pull Google Ads campaign metrics into google_ads_campaigns
// (one row per campaign per day), the Google counterpart to sync-facebook-ads.
// Powers the Marketing module's Google section + the CAC table (Google spend
// kept clearly separate from Meta).
//
// Operator-triggered (user JWT) + cron-safe (x-cron-secret), same as the Meta
// sync. Auth to Google: an OAuth2 refresh token (exchanged for a short-lived
// access token each run) + a Google Ads developer token.
//
// Secrets (set in Edge Function secrets — never in code):
//   GOOGLE_ADS_DEVELOPER_TOKEN     approved developer token (Ads API Center)
//   GOOGLE_ADS_CLIENT_ID           OAuth2 client id
//   GOOGLE_ADS_CLIENT_SECRET       OAuth2 client secret
//   GOOGLE_ADS_REFRESH_TOKEN       refresh token for a user who can read the account
//   GOOGLE_ADS_CUSTOMER_ID         the ad account to pull (digits; dashes are stripped)
//   GOOGLE_ADS_LOGIN_CUSTOMER_ID   optional — the MCC/manager account id, if the
//                                  account sits under a manager (digits)
//   GOOGLE_ADS_API_VERSION         optional — defaults to v26 (bump as Google releases)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { corsHeaders } from '../_shared/cors.ts';
import { authenticate } from '../_shared/auth.ts';

const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';

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

  const devToken     = Deno.env.get('GOOGLE_ADS_DEVELOPER_TOKEN');
  const clientId     = Deno.env.get('GOOGLE_ADS_CLIENT_ID');
  const clientSecret = Deno.env.get('GOOGLE_ADS_CLIENT_SECRET');
  const refreshToken = Deno.env.get('GOOGLE_ADS_REFRESH_TOKEN');
  const rawCustomer  = Deno.env.get('GOOGLE_ADS_CUSTOMER_ID');
  const loginCustomer = (Deno.env.get('GOOGLE_ADS_LOGIN_CUSTOMER_ID') ?? '').replace(/\D/g, '');
  const version = Deno.env.get('GOOGLE_ADS_API_VERSION') ?? 'v26';
  if (!devToken || !clientId || !clientSecret || !refreshToken || !rawCustomer) {
    return j({ error: 'Google Ads not configured: set GOOGLE_ADS_DEVELOPER_TOKEN, GOOGLE_ADS_CLIENT_ID, GOOGLE_ADS_CLIENT_SECRET, GOOGLE_ADS_REFRESH_TOKEN and GOOGLE_ADS_CUSTOMER_ID in Edge Function secrets.' }, 400);
  }
  const customerId = rawCustomer.replace(/\D/g, '');

  // 1) Refresh-token → short-lived access token.
  let accessToken: string;
  try {
    const res = await fetch(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    });
    const body = await res.json();
    if (!res.ok) return j({ error: `Google OAuth ${res.status}: ${JSON.stringify(body).slice(0, 300)}` }, 502);
    accessToken = body.access_token as string;
  } catch (e) {
    return j({ error: `Google OAuth request failed: ${(e as Error).message}` }, 502);
  }

  // 2) Campaign metrics, one row per campaign per day (last 90 days).
  const query = `
    SELECT campaign.id, campaign.name, campaign.status,
           metrics.cost_micros, metrics.impressions, metrics.clicks,
           metrics.conversions, metrics.conversions_value,
           customer.currency_code, segments.date
    FROM campaign
    WHERE segments.date DURING LAST_90_DAYS`;

  const headers: Record<string, string> = {
    'Authorization': `Bearer ${accessToken}`,
    'developer-token': devToken,
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
