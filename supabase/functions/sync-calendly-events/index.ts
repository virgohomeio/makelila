// Pull Calendly scheduled events and upsert into service_tickets as
// onboarding tickets. Dedupe by calendly_event_uri (unique). Matches
// invitee email against customers table to attach customer_id when found.
//
// Env: CALENDLY_TOKEN (personal access token, scope: read scheduled events)
//      CALENDLY_USER_URI (e.g. https://api.calendly.com/users/AAA...)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { corsHeaders } from '../_shared/cors.ts';

type CalendlyEvent = {
  uri: string;
  name: string;
  start_time: string;
  end_time: string;
  status: string;
  event_memberships?: { user_email?: string; user_name?: string }[];
};

type CalendlyInvitee = {
  email?: string;
  name?: string;
  first_name?: string;
  last_name?: string;
  text_reminder_number?: string;
};

const PAGE_SIZE = 50;
const MAX_PAGES = 10; // soft cap = 500 events per run

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
  const calendlyToken = Deno.env.get('CALENDLY_TOKEN');
  const calendlyUserUri = Deno.env.get('CALENDLY_USER_URI');
  if (!supabaseUrl || !serviceKey || !calendlyToken || !calendlyUserUri) {
    return new Response(
      JSON.stringify({ error: 'Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / CALENDLY_TOKEN / CALENDLY_USER_URI' }),
      { status: 500, headers: { ...corsHeaders, 'content-type': 'application/json' } },
    );
  }

  const admin = createClient(supabaseUrl, serviceKey);

  const minStart = new Date(Date.now() - 3600 * 1000).toISOString();         // now - 1h
  const maxStart = new Date(Date.now() + 30 * 86400 * 1000).toISOString();   // now + 30d

  let pageToken: string | undefined = undefined;
  let pages = 0;
  let fetched = 0;
  let upserted = 0;
  const skipped: { uri: string; reason: string }[] = [];

  while (pages < MAX_PAGES) {
    const url = new URL('https://api.calendly.com/scheduled_events');
    url.searchParams.set('user', calendlyUserUri);
    url.searchParams.set('count', String(PAGE_SIZE));
    url.searchParams.set('min_start_time', minStart);
    url.searchParams.set('max_start_time', maxStart);
    url.searchParams.set('status', 'active');
    if (pageToken) url.searchParams.set('page_token', pageToken);

    const res = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${calendlyToken}`,
        'Content-Type': 'application/json',
      },
    });
    if (!res.ok) {
      const body = await res.text();
      return new Response(
        JSON.stringify({ error: `Calendly ${res.status}: ${body.slice(0, 400)}` }),
        { status: 502, headers: { ...corsHeaders, 'content-type': 'application/json' } },
      );
    }
    const json = await res.json() as {
      collection: CalendlyEvent[];
      pagination?: { next_page_token?: string };
    };
    const events = json.collection ?? [];
    fetched += events.length;
    pages++;

    for (const ev of events) {
      // Fetch the first invitee to get customer email
      const inviteesRes = await fetch(`${ev.uri}/invitees`, {
        headers: { Authorization: `Bearer ${calendlyToken}` },
      });
      let invitee: CalendlyInvitee | null = null;
      if (inviteesRes.ok) {
        const inviteesJson = await inviteesRes.json() as { collection: CalendlyInvitee[] };
        invitee = inviteesJson.collection?.[0] ?? null;
      }

      // Find customer_id by email
      let customer_id: string | null = null;
      if (invitee?.email) {
        const { data: cust } = await admin
          .from('customers')
          .select('id')
          .eq('email', invitee.email.toLowerCase())
          .maybeSingle();
        customer_id = cust?.id ?? null;
      }

      const host = ev.event_memberships?.[0];

      const row = {
        category: 'onboarding' as const,
        source: 'calendly' as const,
        status: 'new' as const,
        priority: 'normal' as const,
        customer_id,
        customer_name: invitee?.name ?? null,
        customer_email: invitee?.email?.toLowerCase() ?? null,
        customer_phone: invitee?.text_reminder_number ?? null,
        subject: ev.name || 'Onboarding call',
        description: null,
        calendly_event_uri: ev.uri,
        calendly_event_start: ev.start_time,
        calendly_host_email: host?.user_email ?? null,
      };

      const { error: upErr } = await admin
        .from('service_tickets')
        .upsert(row, { onConflict: 'calendly_event_uri', ignoreDuplicates: false });
      if (upErr) {
        skipped.push({ uri: ev.uri, reason: `db: ${upErr.message}` });
        continue;
      }
      upserted++;

      // Bump matching lifecycle row to onboarding_status='scheduled'
      if (customer_id) {
        await admin
          .from('customer_lifecycle')
          .update({ onboarding_status: 'scheduled' })
          .eq('customer_id', customer_id)
          .eq('onboarding_status', 'not_scheduled');
      }
    }

    pageToken = json.pagination?.next_page_token;
    if (!pageToken) break;
  }

  return new Response(
    JSON.stringify({ pages, fetched, upserted, skipped: skipped.length, skippedDetails: skipped.slice(0, 20) }),
    { status: 200, headers: { ...corsHeaders, 'content-type': 'application/json' } },
  );
}
