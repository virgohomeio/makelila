// sync-search-console: pull Google Search Console daily performance (clicks /
// impressions / CTR / avg position) into gsc_daily via the Search Analytics API.
// Powers the Marketing → Web tab. Operator-triggered + cron-safe.
//
// Secrets: GOOGLE_SERVICE_ACCOUNT_JSON (same key as GA4), GSC_SITE_URL (the exact
// property, e.g. "https://lilacomposter.com/" or "sc-domain:lilacomposter.com").
// The service account must be added as a user on the Search Console property.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { corsHeaders } from '../_shared/cors.ts';
import { authenticate } from '../_shared/auth.ts';
import { getGoogleAccessToken } from '../_shared/google-auth.ts';

type GscRow = { keys?: string[]; clicks?: number; impressions?: number; ctr?: number; position?: number };

function ymd(d: Date): string { return d.toISOString().slice(0, 10); }

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
  const site = Deno.env.get('GSC_SITE_URL');
  if (!saJson || !site) {
    return j({ error: 'Set GOOGLE_SERVICE_ACCOUNT_JSON and GSC_SITE_URL in Edge Function secrets.' }, 400);
  }

  let token: string;
  try {
    token = await getGoogleAccessToken(JSON.parse(saJson), ['https://www.googleapis.com/auth/webmasters.readonly']);
  } catch (e) {
    return j({ error: `Google auth failed: ${(e as Error).message}` }, 502);
  }

  const endDate = ymd(new Date());
  const startDate = ymd(new Date(Date.now() - 90 * 86_400_000));

  let body: { rows?: GscRow[] };
  try {
    const res = await fetch(
      `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ startDate, endDate, dimensions: ['date'], rowLimit: 1000 }),
      },
    );
    body = await res.json();
    if (!res.ok) return j({ error: `Search Console ${res.status}: ${JSON.stringify((body as { error?: unknown }).error ?? body).slice(0, 300)}` }, 502);
  } catch (e) {
    return j({ error: `Search Console request failed: ${(e as Error).message}` }, 502);
  }

  const now = new Date().toISOString();
  const rows = (body.rows ?? []).map(r => ({
    date: r.keys?.[0] ?? '',
    clicks: Math.round(r.clicks ?? 0),
    impressions: Math.round(r.impressions ?? 0),
    ctr: r.ctr != null ? +(r.ctr).toFixed(4) : null,
    position: r.position != null ? +(r.position).toFixed(2) : null,
    synced_at: now,
  })).filter(r => r.date);

  if (rows.length === 0) return j({ synced: 0, note: 'Search Console returned no rows for the last 90 days.' });

  const { error } = await admin.from('gsc_daily').upsert(rows, { onConflict: 'date' });
  if (error) return j({ error: `DB upsert failed: ${error.message}` }, 500);

  return j({ synced: rows.length });
});

function j(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'content-type': 'application/json' },
  });
}
