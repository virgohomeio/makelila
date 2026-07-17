// sync-klaviyo-profile-ids: back-fill customers.klaviyo_profile_id by matching
// each customer's email to their Klaviyo profile. This is the prerequisite for
// klaviyo-pull-events — without a profile id we can't attach a customer's email
// events (opens, active-on-site, checkout, order) to the journey.
//
// Matches in batches via the Klaviyo profiles `any(email,[…])` filter. Insert-
// only: never overwrites an existing id. Operator-triggered + cron-safe.
//
// Secret: KLAVIYO_PRIVATE_KEY (needs Profiles: Read).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { corsHeaders } from '../_shared/cors.ts';
import { authenticate } from '../_shared/auth.ts';

const KLAVIYO_KEY = Deno.env.get('KLAVIYO_PRIVATE_KEY') ?? '';
const KLAVIYO_REV = '2024-10-15';

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

  // Customers with an email but no Klaviyo profile id yet.
  const targets: Array<{ id: string; email: string }> = [];
  {
    let from = 0;
    const size = 1000;
    for (let i = 0; i < 50; i++) {
      const { data, error } = await admin
        .from('customers')
        .select('id, email')
        .not('email', 'is', null)
        .is('klaviyo_profile_id', null)
        .range(from, from + size - 1);
      if (error) return j({ error: `customers read: ${error.message}` }, 500);
      const rows = (data ?? []) as Array<{ id: string; email: string | null }>;
      for (const r of rows) if (r.email) targets.push({ id: r.id, email: r.email });
      if (rows.length < size) break;
      from += size;
    }
  }
  if (targets.length === 0) {
    return j({ linked: 0, note: 'No unlinked customers — everyone with an email already has a Klaviyo profile id.' });
  }

  const headers = {
    'Authorization': `Klaviyo-API-Key ${KLAVIYO_KEY}`,
    'revision': KLAVIYO_REV,
    'Accept': 'application/json',
  };

  let linked = 0;
  let scanned = 0;
  // Batches of 20 keep the response within Klaviyo's default page size.
  for (let i = 0; i < targets.length; i += 20) {
    const batch = targets.slice(i, i + 20);
    const list = batch.map(b => `"${b.email.replace(/"/g, '')}"`).join(',');
    const url = `https://a.klaviyo.com/api/profiles/?filter=${encodeURIComponent(`any(email,[${list}])`)}`;
    let res: Response;
    try { res = await fetch(url, { headers }); }
    catch { continue; }
    if (res.status === 429) { await sleep(2000); i -= 20; continue; }   // rate-limited → retry batch
    if (!res.ok) continue;
    const body = await res.json() as { data?: Array<{ id: string; attributes?: { email?: string } }> };
    const byEmail = new Map<string, string>();
    for (const p of body.data ?? []) {
      const e = p.attributes?.email?.toLowerCase();
      if (e) byEmail.set(e, p.id);
    }
    scanned += batch.length;
    for (const b of batch) {
      const pid = byEmail.get(b.email.toLowerCase());
      if (!pid) continue;
      const { error } = await admin
        .from('customers')
        .update({ klaviyo_profile_id: pid })
        .eq('id', b.id)
        .is('klaviyo_profile_id', null);
      if (!error) linked++;
    }
    await sleep(150);   // stay under Klaviyo's burst limit
  }

  return j({ linked, scanned });
});

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

function j(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'content-type': 'application/json' },
  });
}
