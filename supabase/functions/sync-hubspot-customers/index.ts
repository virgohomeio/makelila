// Pull HubSpot CRM contacts and upsert into public.customers.
//
// Runs against HubSpot's Contacts API v3 with a private app access token.
// Paginates 100/page until exhausted (or hits a soft cap to avoid runaway
// pulls).
//
// Env: HUBSPOT_ACCESS_TOKEN (private app token, scope: crm.objects.contacts.read)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { corsHeaders } from '../_shared/cors.ts';

type HubspotContact = {
  id: string;
  properties: {
    email?: string | null;
    firstname?: string | null;
    lastname?: string | null;
    phone?: string | null;
    address?: string | null;
    city?: string | null;
    state?: string | null;
    zip?: string | null;
    country?: string | null;
    [k: string]: string | null | undefined;
  };
};

const PROPERTIES = [
  'email', 'firstname', 'lastname', 'phone',
  'address', 'city', 'state', 'zip', 'country',
];
const PAGE_SIZE = 100;
const MAX_PAGES = 50; // soft cap = 5,000 contacts per run

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders });
  }
  try { return await handle(); }
  catch (err) {
    return new Response(
      JSON.stringify({ error: `Uncaught: ${(err as Error)?.message ?? String(err)}` }),
      { status: 500, headers: { ...corsHeaders, 'content-type': 'application/json' } },
    );
  }
});

async function handle(): Promise<Response> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const hubspotToken = Deno.env.get('HUBSPOT_ACCESS_TOKEN');
  if (!supabaseUrl || !serviceKey || !hubspotToken) {
    return new Response(
      JSON.stringify({
        error: 'Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / HUBSPOT_ACCESS_TOKEN',
      }),
      { status: 500, headers: { ...corsHeaders, 'content-type': 'application/json' } },
    );
  }

  const admin = createClient(supabaseUrl, serviceKey);

  let after: string | undefined = undefined;
  let pages = 0;
  let fetched = 0;
  let upserted = 0;
  const skipped: { id: string; reason: string }[] = [];
  const now = new Date().toISOString();

  while (pages < MAX_PAGES) {
    const url = new URL('https://api.hubapi.com/crm/v3/objects/contacts');
    url.searchParams.set('limit', String(PAGE_SIZE));
    for (const p of PROPERTIES) url.searchParams.append('properties', p);
    if (after) url.searchParams.set('after', after);

    const res = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${hubspotToken}`,
        'Content-Type': 'application/json',
      },
    });
    if (!res.ok) {
      const body = await res.text();
      return new Response(
        JSON.stringify({ error: `HubSpot ${res.status}: ${body.slice(0, 400)}` }),
        { status: 502, headers: { ...corsHeaders, 'content-type': 'application/json' } },
      );
    }
    const json = await res.json() as {
      results: HubspotContact[];
      paging?: { next?: { after?: string } };
    };
    const results = json.results ?? [];
    fetched += results.length;
    pages++;

    for (const c of results) {
      const p = c.properties ?? {};
      if (!p.email && !p.firstname && !p.lastname) {
        skipped.push({ id: c.id, reason: 'no email / first / last' });
        continue;
      }
      const row = {
        hubspot_id: c.id,
        email: p.email?.toLowerCase() ?? null,
        first_name: p.firstname ?? null,
        last_name: p.lastname ?? null,
        phone: p.phone ?? null,
        address_line: p.address ?? null,
        city: p.city ?? null,
        region: p.state ?? null,
        postal_code: p.zip ?? null,
        country: p.country ?? null,
        last_synced_at: now,
      };
      const { error: upErr } = await admin.from('customers').upsert(row, {
        onConflict: 'hubspot_id',
      });
      if (upErr) {
        skipped.push({ id: c.id, reason: `db: ${upErr.message}` });
        continue;
      }
      upserted++;
    }

    after = json.paging?.next?.after;
    if (!after) break;
  }

  return new Response(
    JSON.stringify({ pages, fetched, upserted, skipped: skipped.length, skippedDetails: skipped.slice(0, 20) }),
    { status: 200, headers: { ...corsHeaders, 'content-type': 'application/json' } },
  );
}
