// sync-fb-demographics: pull Meta purchase conversions broken down by
// age × gender × country × day (per campaign) into fb_demographics. The Journey
// Report uses this to auto-fill a buyer's Age/Gender when a sale maps to exactly
// one clean segment. Only rows with a purchase are stored. LILA Mini campaigns
// are skipped (they convert on Shopline, not the Shopify pixel).
//
// Kept separate from sync-facebook-ads so this heavier breakdown pull can't slow
// or break the main campaign/ad sync.
//
// Secrets: META_SYSTEM_USER_TOKEN, META_AD_ACCOUNT_ID, optional META_API_VERSION.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { corsHeaders } from '../_shared/cors.ts';
import { authenticate } from '../_shared/auth.ts';

type ActionItem = { action_type?: string; value?: string };

// First matching purchase action (priority order) — not a sum, to avoid Meta's
// overlapping purchase action types double-counting.
function purchaseCount(actions?: ActionItem[]): number {
  const keys = ['offsite_conversion.fb_pixel_purchase', 'purchase', 'onsite_web_purchase', 'omni_purchase'];
  for (const k of keys) {
    const hit = actions?.find(a => a.action_type === k);
    if (hit?.value != null && hit.value !== '') return Number(hit.value) || 0;
  }
  return 0;
}

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
  if (!token || !rawAcct) return j({ error: 'Meta not configured: set META_SYSTEM_USER_TOKEN and META_AD_ACCOUNT_ID.' }, 400);
  const acct = rawAcct.startsWith('act_') ? rawAcct : `act_${rawAcct.replace(/\D/g, '')}`;
  const base = `https://graph.facebook.com/${ver}`;

  const now = new Date().toISOString();
  const rows: Record<string, unknown>[] = [];
  try {
    const fields = 'campaign_id,campaign_name,actions,date_start';
    const breakdowns = encodeURIComponent('age,gender,country');
    let url: string | null =
      `${base}/${acct}/insights?level=campaign&fields=${fields}&breakdowns=${breakdowns}` +
      `&time_increment=1&date_preset=maximum&limit=500&access_token=${encodeURIComponent(token)}`;
    let pages = 0;
    while (url && pages < 100) {
      const res = await fetch(url);
      const body = await res.json();
      if (!res.ok) return j({ error: `Meta insights ${res.status}: ${JSON.stringify(body?.error ?? body).slice(0, 300)}` }, 502);
      for (const r of (body.data ?? []) as Array<Record<string, unknown> & { actions?: ActionItem[] }>) {
        const campaignName = String(r.campaign_name ?? '');
        if (/\bmini\b/i.test(campaignName)) continue;      // Shopline, not Shopify
        const purchases = purchaseCount(r.actions);
        if (!r.campaign_id || !r.date_start || purchases <= 0) continue;
        rows.push({
          campaign_id: r.campaign_id,
          date: r.date_start,
          age: String(r.age ?? 'unknown'),
          gender: String(r.gender ?? 'unknown'),
          country: String(r.country ?? 'unknown'),
          purchases,
          synced_at: now,
        });
      }
      url = (body.paging as { next?: string } | undefined)?.next ?? null;
      pages++;
    }
  } catch (e) {
    return j({ error: `Meta insights request failed: ${(e as Error).message}` }, 502);
  }

  // Clean-replace — fully re-derived each run.
  await admin.from('fb_demographics').delete().neq('campaign_id', '');
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await admin.from('fb_demographics').upsert(rows.slice(i, i + 500), { onConflict: 'campaign_id,date,age,gender,country' });
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
