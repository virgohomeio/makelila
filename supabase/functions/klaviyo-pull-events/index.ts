// klaviyo-pull-events: pull each customer's Klaviyo email/engagement events into
// customer_events (source='klaviyo'), so the per-customer Journey shows the email
// leg — opened/clicked email, active on site, viewed product, added to cart,
// started checkout, placed order — and multi-touch ("Meta Ad + Email") becomes
// visible.
//
// Strategy: one global paginated pass over recent Klaviyo events (cheaper than
// per-profile calls), matched to customers by klaviyo_profile_id. Upserts on the
// Klaviyo event id (external_id) so re-runs never duplicate. Operator-triggered
// + cron-safe.
//
// Secrets: KLAVIYO_PRIVATE_KEY (same key klaviyo-track uses).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { corsHeaders } from '../_shared/cors.ts';
import { authenticate } from '../_shared/auth.ts';

const KLAVIYO_KEY = Deno.env.get('KLAVIYO_PRIVATE_KEY') ?? '';
const KLAVIYO_REV = '2024-10-15';

// Metrics worth showing on the journey. Everything else is skipped so the
// timeline stays about the buying-relevant email + onsite signals.
const ALLOWED = new Set([
  'opened email', 'clicked email', 'received email',
  'active on site', 'viewed product', 'added to cart',
  'started checkout', 'placed order', 'ordered product',
  'subscribed to list',
]);

type KEvent = {
  id: string;
  attributes?: { datetime?: string };
  relationships?: {
    profile?: { data?: { id?: string } };
    metric?: { data?: { id?: string } };
  };
};
type KMetric = { type: string; id: string; attributes?: { name?: string } };

function kHeaders(): Record<string, string> {
  return {
    'Authorization': `Klaviyo-API-Key ${KLAVIYO_KEY}`,
    'revision': KLAVIYO_REV,
    'Accept': 'application/json',
  };
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

  if (!KLAVIYO_KEY) return j({ error: 'KLAVIYO_PRIVATE_KEY not configured' }, 400);

  const body = await req.json().catch(() => ({})) as { since?: string; days?: number };
  const days = body.days && body.days > 0 ? body.days : 90;
  const since = body.since ?? new Date(Date.now() - days * 86_400_000).toISOString();

  // customer klaviyo_profile_id → customer_id
  const profileToCustomer = new Map<string, string>();
  {
    let from = 0;
    const pageSize = 1000;
    // Page through customers so we don't miss anyone with a profile id.
    for (let i = 0; i < 50; i++) {
      const { data, error } = await admin
        .from('customers')
        .select('id, klaviyo_profile_id')
        .not('klaviyo_profile_id', 'is', null)
        .range(from, from + pageSize - 1);
      if (error) return j({ error: `customers read: ${error.message}` }, 500);
      for (const r of (data ?? []) as Array<{ id: string; klaviyo_profile_id: string }>) {
        profileToCustomer.set(r.klaviyo_profile_id, r.id);
      }
      if (!data || data.length < pageSize) break;
      from += pageSize;
    }
  }
  if (profileToCustomer.size === 0) {
    return j({ synced: 0, note: 'No customers have a klaviyo_profile_id yet (they get one from klaviyo-track). Nothing to pull.' });
  }

  // Global paginated events pass since `since`.
  const rows: Record<string, unknown>[] = [];
  let url: string | null =
    `https://a.klaviyo.com/api/events/?filter=${encodeURIComponent(`greater-or-equal(datetime,${since})`)}&include=metric&sort=-datetime&page%5Bsize%5D=200`;
  let pages = 0;
  let scanned = 0;
  try {
    while (url && pages < 40) {
      const res = await fetch(url, { headers: kHeaders() });
      if (!res.ok) return j({ error: `Klaviyo events ${res.status}: ${(await res.text()).slice(0, 300)}` }, 502);
      const payload = await res.json() as { data?: KEvent[]; included?: KMetric[]; links?: { next?: string | null } };

      const metricName = new Map<string, string>();
      for (const inc of payload.included ?? []) {
        if (inc.type === 'metric' && inc.attributes?.name) metricName.set(inc.id, inc.attributes.name);
      }

      for (const ev of payload.data ?? []) {
        scanned++;
        const pid = ev.relationships?.profile?.data?.id;
        const customerId = pid ? profileToCustomer.get(pid) : undefined;
        if (!customerId) continue;
        const name = ev.relationships?.metric?.data?.id ? metricName.get(ev.relationships.metric.data.id) : undefined;
        if (!name || !ALLOWED.has(name.toLowerCase())) continue;
        rows.push({
          external_id: `klaviyo:${ev.id}`,
          customer_id: customerId,
          event_type: `klaviyo.${slug(name)}`,
          event_payload: { metric: name },
          source: 'klaviyo',
          occurred_at: ev.attributes?.datetime ?? since,
        });
      }
      url = payload.links?.next ?? null;
      pages++;
    }
  } catch (e) {
    return j({ error: `Klaviyo request failed: ${(e as Error).message}` }, 502);
  }

  // Upsert in chunks, deduped on external_id.
  let synced = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { error } = await admin.from('customer_events').upsert(chunk, { onConflict: 'external_id' });
    if (error) return j({ error: `DB upsert failed: ${error.message}` }, 500);
    synced += chunk.length;
  }

  return j({ synced, scanned, since, profiles: profileToCustomer.size });
});

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function j(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'content-type': 'application/json' },
  });
}
