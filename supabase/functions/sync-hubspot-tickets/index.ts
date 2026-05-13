// Pull HubSpot CRM tickets and upsert into service_tickets. Phase 1:
// inbound only (HubSpot is source of truth, we mirror). Dedupe by
// hubspot_ticket_id (unique). Matches associated contact email against
// customers table to attach customer_id when found.
//
// Env: HUBSPOT_ACCESS_TOKEN (private app token, scope: tickets.read)
//
// Pipeline stage → status mapping (HubSpot defaults):
//   1 (New)              → new
//   2 (Waiting on contact)→ waiting_customer
//   3 (Waiting on us)    → in_progress
//   4 (Closed)           → resolved
// Other stage ids fall through to 'new'.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { corsHeaders } from '../_shared/cors.ts';

type HubspotTicket = {
  id: string;
  properties: {
    subject?: string | null;
    content?: string | null;
    hs_pipeline?: string | null;
    hs_pipeline_stage?: string | null;
    hs_ticket_priority?: string | null;   // HIGH | MEDIUM | LOW
    hs_ticket_category?: string | null;
    createdate?: string | null;
    hubspot_owner_id?: string | null;
    [k: string]: string | null | undefined;
  };
};

const PROPERTIES = [
  'subject','content','hs_pipeline','hs_pipeline_stage',
  'hs_ticket_priority','hs_ticket_category','createdate','hubspot_owner_id',
];
const PAGE_SIZE = 100;
const MAX_PAGES = 20; // soft cap = 2,000 tickets per run

function mapStage(stage: string | null | undefined): 'new' | 'waiting_customer' | 'in_progress' | 'resolved' {
  switch (stage) {
    case '2': return 'waiting_customer';
    case '3': return 'in_progress';
    case '4': return 'resolved';
    default:  return 'new';
  }
}
function mapPriority(p: string | null | undefined): 'low' | 'normal' | 'high' | 'urgent' {
  switch ((p ?? '').toUpperCase()) {
    case 'HIGH':   return 'high';
    case 'LOW':    return 'low';
    case 'URGENT': return 'urgent';
    default:       return 'normal';
  }
}
function mapCategory(c: string | null | undefined): 'support' | 'repair' {
  if (!c) return 'support';
  const v = c.toLowerCase();
  if (v.includes('repair') || v.includes('defect') || v.includes('hardware')) return 'repair';
  return 'support';
}

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
      JSON.stringify({ error: 'Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / HUBSPOT_ACCESS_TOKEN' }),
      { status: 500, headers: { ...corsHeaders, 'content-type': 'application/json' } },
    );
  }

  const admin = createClient(supabaseUrl, serviceKey);

  let after: string | undefined = undefined;
  let pages = 0;
  let fetched = 0;
  let upserted = 0;
  const skipped: { id: string; reason: string }[] = [];

  while (pages < MAX_PAGES) {
    const url = new URL('https://api.hubapi.com/crm/v3/objects/tickets');
    url.searchParams.set('limit', String(PAGE_SIZE));
    for (const p of PROPERTIES) url.searchParams.append('properties', p);
    url.searchParams.set('associations', 'contacts');
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
      results: (HubspotTicket & { associations?: { contacts?: { results?: { id: string }[] } } })[];
      paging?: { next?: { after?: string } };
    };
    const results = json.results ?? [];
    fetched += results.length;
    pages++;

    for (const t of results) {
      const p = t.properties ?? {};
      if (!p.subject) {
        skipped.push({ id: t.id, reason: 'no subject' });
        continue;
      }

      // Resolve associated contact → customer
      let customer_id: string | null = null;
      let customer_email: string | null = null;
      let customer_name: string | null = null;
      const contactId = t.associations?.contacts?.results?.[0]?.id;
      if (contactId) {
        const { data: cust } = await admin
          .from('customers')
          .select('id, email, first_name, last_name')
          .eq('hubspot_id', contactId)
          .maybeSingle();
        if (cust) {
          customer_id = cust.id;
          customer_email = cust.email;
          customer_name = [cust.first_name, cust.last_name].filter(Boolean).join(' ') || null;
        }
      }

      const row = {
        hubspot_ticket_id: t.id,
        category: mapCategory(p.hs_ticket_category),
        source: 'hubspot' as const,
        status: mapStage(p.hs_pipeline_stage),
        priority: mapPriority(p.hs_ticket_priority),
        customer_id,
        customer_name,
        customer_email,
        subject: p.subject ?? '(no subject)',
        description: p.content ?? null,
      };

      const { error: upErr } = await admin
        .from('service_tickets')
        .upsert(row, { onConflict: 'hubspot_ticket_id', ignoreDuplicates: false });
      if (upErr) {
        skipped.push({ id: t.id, reason: `db: ${upErr.message}` });
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
