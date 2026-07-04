// sync-ga4: pull GA4 web analytics (sessions / users / conversions by day +
// default channel group) into ga4_daily via the Analytics Data API. Powers the
// Marketing → Web tab. Operator-triggered + cron-safe.
//
// Secrets: GOOGLE_SERVICE_ACCOUNT_JSON (the full service-account key JSON),
// GA4_PROPERTY_ID (the numeric property id, e.g. 123456789). The service account
// must be added as a Viewer on the GA4 property.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { corsHeaders } from '../_shared/cors.ts';
import { authenticate } from '../_shared/auth.ts';
import { getGoogleAccessToken } from '../_shared/google-auth.ts';

type GaRow = { dimensionValues?: { value?: string }[]; metricValues?: { value?: string }[] };

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
  const propertyId = (Deno.env.get('GA4_PROPERTY_ID') ?? '').replace(/\D/g, '');
  if (!saJson || !propertyId) {
    return j({ error: 'Set GOOGLE_SERVICE_ACCOUNT_JSON and GA4_PROPERTY_ID in Edge Function secrets.' }, 400);
  }

  let token: string;
  try {
    token = await getGoogleAccessToken(JSON.parse(saJson), ['https://www.googleapis.com/auth/analytics.readonly']);
  } catch (e) {
    return j({ error: `Google auth failed: ${(e as Error).message}` }, 502);
  }

  let body: { rows?: GaRow[] };
  try {
    const res = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        dateRanges: [{ startDate: '90daysAgo', endDate: 'today' }],
        dimensions: [{ name: 'date' }, { name: 'sessionDefaultChannelGroup' }],
        metrics: [{ name: 'sessions' }, { name: 'totalUsers' }, { name: 'conversions' }],
        limit: 10000,
      }),
    });
    body = await res.json();
    if (!res.ok) return j({ error: `GA4 ${res.status}: ${JSON.stringify((body as { error?: unknown }).error ?? body).slice(0, 300)}` }, 502);
  } catch (e) {
    return j({ error: `GA4 request failed: ${(e as Error).message}` }, 502);
  }

  const now = new Date().toISOString();
  const rows = (body.rows ?? []).map(r => {
    const rawDate = r.dimensionValues?.[0]?.value ?? '';            // YYYYMMDD
    const date = rawDate.length === 8 ? `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}` : rawDate;
    return {
      date,
      channel: r.dimensionValues?.[1]?.value ?? 'Unknown',
      sessions: num(r.metricValues?.[0]?.value),
      users: num(r.metricValues?.[1]?.value),
      conversions: num(r.metricValues?.[2]?.value),
      synced_at: now,
    };
  }).filter(r => r.date);

  if (rows.length === 0) return j({ synced: 0, note: 'GA4 returned no rows for the last 90 days.' });

  const { error } = await admin.from('ga4_daily').upsert(rows, { onConflict: 'date,channel' });
  if (error) return j({ error: `DB upsert failed: ${error.message}` }, 500);

  return j({ synced: rows.length });
});

function num(v: string | undefined): number {
  return v != null && v !== '' && !isNaN(Number(v)) ? Number(v) : 0;
}

function j(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'content-type': 'application/json' },
  });
}
