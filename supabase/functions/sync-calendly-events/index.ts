// Pull Calendly scheduled events and upsert into service_tickets as
// onboarding tickets. Dedupe by calendly_event_uri (unique). Matches
// invitee email against customers table to attach customer_id when found.
//
// Env: CALENDLY_TOKEN (personal access token, scope: read scheduled events)
//      CALENDLY_USER_URI (e.g. https://api.calendly.com/users/AAA...)
//
// Backlog #44 — when REINA_INVITE_EMAIL is set, also sends Reina a Google
// Calendar invite for each upcoming onboarding event so she joins as a
// co-host. Requires:
//      REINA_INVITE_EMAIL        target attendee, e.g. reina@virgohome.io
//      CALENDAR_INVITER_MAILBOX  Workspace mailbox the event is created
//                                on (delegated via the same service
//                                account used for Gmail sync), e.g.
//                                onboarding@virgohome.io or huayi@virgohome.io
//      GOOGLE_SERVICE_ACCOUNT_KEY  (existing) base64 service account JSON.
//                                  The service account's domain-wide
//                                  delegation must include the calendar
//                                  scope: https://www.googleapis.com/auth/calendar.events
// Dedupe is via service_tickets.reina_invited_at — when set, the cron
// won't re-fire. Missing env = soft no-op (no invite sent, sync proceeds).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { SignJWT, importPKCS8 } from 'https://esm.sh/jose@5.9.6';
import { corsHeaders } from '../_shared/cors.ts';
import { authenticate } from '../_shared/auth.ts';

const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events';

type ServiceAccountKey = {
  client_email: string;
  private_key: string;
  token_uri: string;
};

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
  try { return await handle(req); }
  catch (err) {
    return new Response(
      JSON.stringify({ error: `Uncaught: ${(err as Error)?.message ?? String(err)}` }),
      { status: 500, headers: { ...corsHeaders, 'content-type': 'application/json' } },
    );
  }
});

async function handle(req: Request): Promise<Response> {
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

  let _caller;
  try { _caller = await authenticate(req, admin); }
  catch (e) { if (e instanceof Response) return e; throw e; }
  // Reject UI-triggered calls — these functions only run from pg_cron.
  if (_caller.kind !== 'cron') {
    return new Response(
      JSON.stringify({ error: 'This function is cron-only — use the X-Cron-Secret header.' }),
      { status: 403, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' } },
    );
  }

  // Backlog #44 — resolve Reina-invite config once per run. Soft no-op
  // when any piece is missing so the core sync keeps working.
  const reinaEmail        = Deno.env.get('REINA_INVITE_EMAIL') ?? null;
  const calendarInviter   = Deno.env.get('CALENDAR_INVITER_MAILBOX') ?? null;
  const saKeyB64          = Deno.env.get('GOOGLE_SERVICE_ACCOUNT_KEY') ?? null;
  let calendarToken: string | null = null;
  if (reinaEmail && calendarInviter && saKeyB64) {
    try {
      const saKey = JSON.parse(atob(saKeyB64)) as ServiceAccountKey;
      calendarToken = await getCalendarAccessToken(saKey, calendarInviter);
    } catch (e) {
      // Don't fail the sync — log and fall through to invite-skipped path.
      console.error('Reina-invite token fetch failed:', (e as Error).message);
    }
  }
  const inviteEnabled = !!(reinaEmail && calendarInviter && calendarToken);
  let invitesSent = 0;
  let invitesSkipped = 0;
  const inviteErrors: { uri: string; reason: string }[] = [];

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

      const { data: upRow, error: upErr } = await admin
        .from('service_tickets')
        .upsert(row, { onConflict: 'calendly_event_uri', ignoreDuplicates: false })
        .select('id, reina_invited_at, calendly_event_start')
        .single();
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

      // Backlog #44 — invite Reina if not already done and the event is
      // still in the future. Skips silently when env isn't configured;
      // failures don't break the sync.
      if (
        inviteEnabled
        && !upRow?.reina_invited_at
        && Date.parse(ev.start_time) > Date.now()
      ) {
        try {
          await createCalendarInvite(calendarToken!, calendarInviter!, {
            summary: `Onboarding co-host: ${invitee?.name ?? row.customer_name ?? 'Customer'}`,
            description: [
              `Calendly: ${ev.uri}`,
              row.customer_email ? `Customer: ${row.customer_name ?? ''} <${row.customer_email}>` : null,
              `Joining as a co-host on the customer onboarding call.`,
            ].filter(Boolean).join('\n'),
            start: ev.start_time,
            end:   ev.end_time,
            attendees: [reinaEmail!],
          });
          await admin
            .from('service_tickets')
            .update({ reina_invited_at: new Date().toISOString() })
            .eq('id', upRow.id);
          invitesSent++;
        } catch (e) {
          inviteErrors.push({ uri: ev.uri, reason: (e as Error).message.slice(0, 200) });
        }
      } else if (inviteEnabled) {
        invitesSkipped++;
      }
    }

    pageToken = json.pagination?.next_page_token;
    if (!pageToken) break;
  }

  return new Response(
    JSON.stringify({
      pages, fetched, upserted,
      skipped: skipped.length, skippedDetails: skipped.slice(0, 20),
      reinaInvite: inviteEnabled
        ? { enabled: true, sent: invitesSent, alreadySent: invitesSkipped, errors: inviteErrors.slice(0, 10) }
        : { enabled: false, reason: 'REINA_INVITE_EMAIL / CALENDAR_INVITER_MAILBOX / GOOGLE_SERVICE_ACCOUNT_KEY not all set' },
    }),
    { status: 200, headers: { ...corsHeaders, 'content-type': 'application/json' } },
  );
}

// ============================================================ Google Calendar
// (Backlog #44 — kept inline rather than extracted to _shared/ to limit
// the blast radius of this change. If/when more functions need Calendar,
// promote getCalendarAccessToken + createCalendarInvite into a shared
// helper alongside sync-gmail-tickets' getAccessToken.)

async function getCalendarAccessToken(
  saKey: ServiceAccountKey, delegatedSubject: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const privateKey = await importPKCS8(saKey.private_key, 'RS256');
  const assertion = await new SignJWT({ scope: CALENDAR_SCOPE })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuer(saKey.client_email)
    .setSubject(delegatedSubject)
    .setAudience(saKey.token_uri)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(privateKey);

  const res = await fetch(saKey.token_uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  if (!res.ok) {
    throw new Error(`Google token endpoint ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const json = await res.json() as { access_token?: string };
  if (!json.access_token) throw new Error('Google token endpoint returned no access_token');
  return json.access_token;
}

async function createCalendarInvite(
  accessToken: string,
  calendarId: string,   // delegated subject; use 'primary' for that mailbox's primary calendar
  ev: {
    summary: string;
    description: string;
    start: string;       // ISO 8601
    end: string;         // ISO 8601
    attendees: string[];
  },
): Promise<void> {
  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?sendUpdates=all`;
  const body = {
    summary: ev.summary,
    description: ev.description,
    start: { dateTime: ev.start },
    end:   { dateTime: ev.end },
    attendees: ev.attendees.map(email => ({ email })),
    reminders: { useDefault: true },
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Calendar events.insert ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
}
