// Backlog #74 + #75 — poll Huayi's Google Calendar for appointment-schedule
// bookings (the diagnosis-call link sent from the ticket detail panel
// resolves to a Google Appointment Schedule, not Calendly), upsert each
// into service_tickets, and auto-invite Reina + Junaid as co-hosts.
//
// Architecture mirrors sync-calendly-events: cron-only, dedupe via a
// unique key on service_tickets (google_calendar_event_id), invite path
// stamps a separate column (diag_cohost_invited_at).
//
// Env:
//   GOOGLE_SERVICE_ACCOUNT_KEY   (existing) base64 service-account JSON
//   CALENDAR_INVITER_MAILBOX     (existing) the mailbox whose calendar
//                                hosts the bookings (Huayi). The service
//                                account's domain-wide delegation must
//                                include https://www.googleapis.com/auth/calendar.events
//   DIAGNOSIS_COHOST_EMAILS      comma-separated list of co-hosts to
//                                invite (e.g. reina@virgohome.io,junaid@virgohome.io)
//   DIAGNOSIS_SUMMARY_PATTERN    optional regex (case-insensitive) used
//                                to identify which calendar events are
//                                diagnosis-call bookings. Defaults to
//                                `diagnosis` — matches any event whose
//                                summary contains "diagnosis". Operator
//                                tunes this if the booking event name
//                                differs (e.g. "LILA support call").
//   DIAGNOSIS_PROBE_LOG          when 'true', logs the full JSON of each
//                                matched calendar event for the first
//                                run after deploy (#74 probe — lets you
//                                inspect what fields Google actually
//                                returns so the pattern can be tightened).
//
// Missing env (DIAGNOSIS_COHOST_EMAILS or CALENDAR_INVITER_MAILBOX or
// GOOGLE_SERVICE_ACCOUNT_KEY) ⇒ soft no-op. The function returns
// {enabled:false, reason} so the cron log shows why nothing happened.

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

type CalendarAttendee = {
  email?: string;
  displayName?: string;
  responseStatus?: string;
  organizer?: boolean;
  self?: boolean;
};

type CalendarEvent = {
  id: string;
  summary?: string;
  description?: string;
  start?: { dateTime?: string; date?: string };
  end?:   { dateTime?: string; date?: string };
  attendees?: CalendarAttendee[];
  organizer?: { email?: string; self?: boolean };
  eventType?: string;
  status?: string;
  htmlLink?: string;
  extendedProperties?: Record<string, unknown>;
};

const INTERNAL_DOMAIN = '@virgohome.io';
const PAGE_SIZE = 250;

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
  const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceKey) {
    return jsonResponse({ error: 'Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY' }, 500);
  }
  const admin = createClient(supabaseUrl, serviceKey);

  // Cron-only — matches sync-calendly-events.
  let caller;
  try { caller = await authenticate(req, admin); }
  catch (e) { if (e instanceof Response) return e; throw e; }
  if (caller.kind !== 'cron') {
    return jsonResponse({ error: 'This function is cron-only — use the X-Cron-Secret header.' }, 403);
  }

  const calendarInviter = Deno.env.get('CALENDAR_INVITER_MAILBOX') ?? null;
  const saKeyB64        = Deno.env.get('GOOGLE_SERVICE_ACCOUNT_KEY') ?? null;
  const cohostsRaw      = Deno.env.get('DIAGNOSIS_COHOST_EMAILS') ?? '';
  const cohosts         = cohostsRaw.split(',').map(s => s.trim()).filter(Boolean);
  const summaryPattern  = Deno.env.get('DIAGNOSIS_SUMMARY_PATTERN') ?? 'diagnosis';
  const probeLog        = (Deno.env.get('DIAGNOSIS_PROBE_LOG') ?? '').toLowerCase() === 'true';

  if (!calendarInviter || !saKeyB64 || cohosts.length === 0) {
    return jsonResponse({
      enabled: false,
      reason: 'CALENDAR_INVITER_MAILBOX / GOOGLE_SERVICE_ACCOUNT_KEY / DIAGNOSIS_COHOST_EMAILS not all set',
    }, 200);
  }

  let saKey: ServiceAccountKey;
  try {
    saKey = JSON.parse(atob(saKeyB64)) as ServiceAccountKey;
  } catch (e) {
    return jsonResponse({ error: `GOOGLE_SERVICE_ACCOUNT_KEY decode/parse failed: ${(e as Error).message}` }, 500);
  }

  let token: string;
  try {
    token = await getCalendarAccessToken(saKey, calendarInviter);
  } catch (e) {
    return jsonResponse({ error: `Calendar token: ${(e as Error).message}` }, 500);
  }

  // Window: last 1h (catch bookings made very recently for past slots) through next 30d.
  const minStart = new Date(Date.now() - 3600 * 1000).toISOString();
  const maxStart = new Date(Date.now() + 30 * 86400 * 1000).toISOString();

  let pattern: RegExp;
  try {
    pattern = new RegExp(summaryPattern, 'i');
  } catch (e) {
    return jsonResponse({ error: `Invalid DIAGNOSIS_SUMMARY_PATTERN regex: ${(e as Error).message}` }, 500);
  }

  let fetched = 0;
  let matched = 0;
  let upserted = 0;
  let invitesSent = 0;
  let invitesSkipped = 0;
  const errors: { id: string; reason: string }[] = [];
  const probeSamples: CalendarEvent[] = [];

  // events.list paginates via pageToken.
  let pageToken: string | undefined = undefined;
  do {
    const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarInviter)}/events`);
    url.searchParams.set('timeMin', minStart);
    url.searchParams.set('timeMax', maxStart);
    url.searchParams.set('singleEvents', 'true');
    url.searchParams.set('orderBy', 'startTime');
    url.searchParams.set('maxResults', String(PAGE_SIZE));
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      return jsonResponse({
        error: `Calendar events.list ${res.status}: ${(await res.text()).slice(0, 400)}`,
      }, 502);
    }
    const json = await res.json() as { items?: CalendarEvent[]; nextPageToken?: string };
    const events = json.items ?? [];
    fetched += events.length;

    for (const ev of events) {
      // Skip cancelled events and events without a start time.
      if (ev.status === 'cancelled' || !ev.start?.dateTime) continue;

      // Must match the summary pattern (default: "diagnosis").
      const summary = ev.summary ?? '';
      if (!pattern.test(summary)) continue;

      // Must have at least one external attendee — internal-only events
      // (e.g. team meetings tagged "diagnosis postmortem") shouldn't fan out.
      const external = (ev.attendees ?? []).filter(a => a.email && !a.email.endsWith(INTERNAL_DOMAIN));
      if (external.length === 0) continue;

      matched++;
      if (probeLog && probeSamples.length < 3) probeSamples.push(ev);

      const customerAttendee = external[0];
      const customerEmail = customerAttendee.email?.toLowerCase() ?? null;
      const customerName  = customerAttendee.displayName ?? null;

      // Best-effort customer FK lookup by email.
      let customer_id: string | null = null;
      if (customerEmail) {
        const { data: cust } = await admin
          .from('customers')
          .select('id')
          .eq('email', customerEmail)
          .maybeSingle();
        customer_id = cust?.id ?? null;
      }

      const ticketRow = {
        category: 'diagnosis_call' as const,
        source:   'google_calendar' as const,
        status:   'scheduled' as const,
        priority: 'normal' as const,
        customer_id,
        customer_name:  customerName,
        customer_email: customerEmail,
        subject: summary || 'Diagnosis call',
        description: ev.description ?? null,
        google_calendar_event_id: ev.id,
        calendly_event_start: ev.start.dateTime,    // reuse the existing column for start time
        calendly_host_email:  ev.organizer?.email ?? calendarInviter,
      };

      const { data: upRow, error: upErr } = await admin
        .from('service_tickets')
        .upsert(ticketRow, { onConflict: 'google_calendar_event_id', ignoreDuplicates: false })
        .select('id, diag_cohost_invited_at')
        .single();
      if (upErr) {
        errors.push({ id: ev.id, reason: `db: ${upErr.message}` });
        continue;
      }
      upserted++;

      // Skip the invite if already sent, or if the event already lists
      // all required co-hosts (operator added them manually).
      const alreadyInvited = new Set(
        (ev.attendees ?? []).map(a => (a.email ?? '').toLowerCase()).filter(Boolean),
      );
      const missingCohosts = cohosts.filter(e => !alreadyInvited.has(e.toLowerCase()));
      if (upRow?.diag_cohost_invited_at || missingCohosts.length === 0) {
        invitesSkipped++;
        continue;
      }

      try {
        await patchEventAttendees(token, calendarInviter, ev.id, [
          ...(ev.attendees ?? []),
          ...missingCohosts.map(email => ({ email })),
        ]);
        await admin
          .from('service_tickets')
          .update({ diag_cohost_invited_at: new Date().toISOString() })
          .eq('id', upRow.id);
        invitesSent++;
      } catch (e) {
        errors.push({ id: ev.id, reason: `invite: ${(e as Error).message.slice(0, 200)}` });
      }
    }

    pageToken = json.nextPageToken;
  } while (pageToken);

  return jsonResponse({
    enabled: true,
    inviter: calendarInviter,
    cohosts,
    summary_pattern: summaryPattern,
    fetched,
    matched,
    upserted,
    invites: { sent: invitesSent, skipped: invitesSkipped, errors: errors.slice(0, 10) },
    probe_samples: probeLog ? probeSamples : undefined,
  }, 200);
}

// ============================================================ Google helpers

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

/** PATCH the event with a new attendees array. sendUpdates=all so the
 *  newly-added co-hosts get the standard calendar invite email + the
 *  event lands on their calendars. */
async function patchEventAttendees(
  accessToken: string,
  calendarId: string,
  eventId: string,
  attendees: { email?: string; displayName?: string; responseStatus?: string; organizer?: boolean; self?: boolean }[],
): Promise<void> {
  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=all`;
  const cleanAttendees = attendees
    .filter(a => a.email)
    .map(a => ({ email: a.email!, displayName: a.displayName, responseStatus: a.responseStatus }));
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ attendees: cleanAttendees }),
  });
  if (!res.ok) {
    throw new Error(`Calendar events.patch ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'content-type': 'application/json' },
  });
}
