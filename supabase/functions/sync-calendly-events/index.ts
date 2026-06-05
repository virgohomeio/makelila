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

  // Backlog #44 + #75 — co-host invite config. Resolved once per run.
  // Soft no-op when any piece is missing so the core sync keeps working.
  //   • REINA_INVITE_EMAIL          — sole co-host for ONBOARDING events (#44)
  //   • DIAGNOSIS_COHOST_EMAILS     — comma-separated co-hosts for DIAGNOSIS events (#75)
  //   • CALENDAR_INVITER_MAILBOX    — mailbox whose calendar Calendly writes to
  //   • GOOGLE_SERVICE_ACCOUNT_KEY  — base64 SA JSON with calendar.events DWD
  // Diagnosis events are identified by Calendly event-type name (default
  // "LILA Diagnosis Chat"). Operator-tunable without redeploy.
  const reinaEmail        = Deno.env.get('REINA_INVITE_EMAIL') ?? null;
  const diagnosisCohosts  = (Deno.env.get('DIAGNOSIS_COHOST_EMAILS') ?? '')
    .split(',').map(s => s.trim()).filter(Boolean);
  const calendarInviter   = Deno.env.get('CALENDAR_INVITER_MAILBOX') ?? null;
  const saKeyB64          = Deno.env.get('GOOGLE_SERVICE_ACCOUNT_KEY') ?? null;
  // Reina is off Saturday + Sunday — skip invites for events that fall
  // on weekends in her local timezone. Configurable via env in case she
  // ever changes timezones.
  const reinaTimezone     = Deno.env.get('REINA_TIMEZONE') ?? 'America/Toronto';
  // Substring (case-insensitive) for classifying a Calendly event-type
  // name as a diagnosis call. Default matches "LILA Diagnosis Chat".
  const diagnosisPattern  = (Deno.env.get('DIAGNOSIS_EVENT_NAME_MATCH') ?? 'diagnosis').toLowerCase();
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

      // Backlog #75 — classify the Calendly event-type. "LILA Diagnosis
      // Chat" (or whatever DIAGNOSIS_EVENT_NAME_MATCH points at) lands
      // in category='diagnosis_call' with Reina+Junaid as co-hosts; all
      // other event-types stay 'onboarding' with just Reina.
      const isDiagnosis = (ev.name ?? '').toLowerCase().includes(diagnosisPattern);
      const category = isDiagnosis ? 'diagnosis_call' as const : 'onboarding' as const;

      const row = {
        category,
        source: 'calendly' as const,
        status: 'call_scheduled' as const,
        priority: 'normal' as const,
        customer_id,
        customer_name: invitee?.name ?? null,
        customer_email: invitee?.email?.toLowerCase() ?? null,
        customer_phone: invitee?.text_reminder_number ?? null,
        subject: ev.name || (isDiagnosis ? 'Diagnosis call' : 'Onboarding call'),
        description: null,
        calendly_event_uri: ev.uri,
        calendly_event_start: ev.start_time,
        calendly_host_email: host?.user_email ?? null,
      };

      const { data: upRow, error: upErr } = await admin
        .from('service_tickets')
        .upsert(row, { onConflict: 'calendly_event_uri', ignoreDuplicates: false })
        .select('id, reina_invited_at, diag_cohost_invited_at, calendly_event_start')
        .single();
      if (upErr) {
        skipped.push({ uri: ev.uri, reason: `db: ${upErr.message}` });
        continue;
      }
      upserted++;

      // Bump matching lifecycle row to onboarding_status='scheduled'
      // (only meaningful for actual onboarding events).
      if (!isDiagnosis && customer_id) {
        await admin
          .from('customer_lifecycle')
          .update({ onboarding_status: 'scheduled' })
          .eq('customer_id', customer_id)
          .eq('onboarding_status', 'not_scheduled');
      }

      // ─── Co-host invite path ──────────────────────────────────────────
      // Onboarding events  → invite Reina  (dedupe via reina_invited_at)
      // Diagnosis events   → invite Reina + Junaid (dedupe via diag_cohost_invited_at)
      // Both: skip past events, skip weekends in Reina's tz (she's off Sat+Sun
      // — and Calendly already enforces M-F availability for both event-types
      // today, so the weekend check is defensive).
      //
      // Approach in both cases: find the Google Calendar event Calendly
      // created on calendarInviter's calendar by start-time + customer
      // email match, then PATCH its attendees to add the co-hosts
      // (sendUpdates=all so they get the standard invitation email).
      const cohosts: string[] = isDiagnosis
        ? diagnosisCohosts
        : (reinaEmail ? [reinaEmail] : []);
      const alreadyDone = isDiagnosis
        ? !!upRow?.diag_cohost_invited_at
        : !!upRow?.reina_invited_at;
      const stampColumn = isDiagnosis ? 'diag_cohost_invited_at' : 'reina_invited_at';

      const cohostsConfigured = cohosts.length > 0;
      if (
        inviteEnabled
        && cohostsConfigured
        && !alreadyDone
        && Date.parse(ev.start_time) > Date.now()
      ) {
        if (isWeekendInTimezone(ev.start_time, reinaTimezone)) {
          invitesSkipped++;
          // Don't stamp — leaves the door open if the event reschedules.
        } else {
          try {
            const matched = await findCalendlyEventOnCalendar(
              calendarToken!,
              calendarInviter!,
              ev.start_time,
              invitee?.email ?? null,
            );
            if (!matched) {
              inviteErrors.push({
                uri: ev.uri,
                reason: `No matching event on ${calendarInviter}'s calendar at ${ev.start_time}`,
              });
            } else {
              await addAttendeesToCalendarEvent(
                calendarToken!,
                calendarInviter!,
                matched.id,
                matched.attendees ?? [],
                cohosts,
              );
              await admin
                .from('service_tickets')
                .update({ [stampColumn]: new Date().toISOString() })
                .eq('id', upRow.id);
              invitesSent++;
            }
          } catch (e) {
            inviteErrors.push({ uri: ev.uri, reason: (e as Error).message.slice(0, 200) });
          }
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
      coHostInvite: inviteEnabled
        ? {
            enabled: true,
            onboardingCohost: reinaEmail,
            diagnosisCohosts,
            diagnosisPattern,
            sent: invitesSent,
            skipped: invitesSkipped,
            errors: inviteErrors.slice(0, 10),
          }
        : {
            enabled: false,
            reason: 'REINA_INVITE_EMAIL / CALENDAR_INVITER_MAILBOX / GOOGLE_SERVICE_ACCOUNT_KEY not all set',
          },
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

/** Returns true when the given ISO timestamp falls on a Sat/Sun in the
 *  given IANA timezone. Used to skip Reina's co-host invite for weekend
 *  bookings (she doesn't work weekends). */
function isWeekendInTimezone(isoTs: string, timezone: string): boolean {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
  });
  const wd = fmt.format(new Date(isoTs));
  return wd === 'Sat' || wd === 'Sun';
}

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
  start?: { dateTime?: string };
  end?:   { dateTime?: string };
  attendees?: CalendarAttendee[];
  status?: string;
};

/** Locate the Google Calendar event Calendly created for a given
 *  scheduled-event start time + invitee email. We list events in a
 *  ±2 minute window around the Calendly start time and pick the first
 *  one whose attendee list contains the customer's email. ±2 min covers
 *  small clock skew between Calendly's stored time and Google's stored
 *  time without grabbing adjacent bookings. */
async function findCalendlyEventOnCalendar(
  accessToken: string,
  calendarId: string,
  calendlyStartIso: string,
  customerEmail: string | null,
): Promise<CalendarEvent | null> {
  const startMs = Date.parse(calendlyStartIso);
  const timeMin = new Date(startMs - 2 * 60 * 1000).toISOString();
  const timeMax = new Date(startMs + 2 * 60 * 1000).toISOString();

  const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`);
  url.searchParams.set('timeMin', timeMin);
  url.searchParams.set('timeMax', timeMax);
  url.searchParams.set('singleEvents', 'true');
  url.searchParams.set('orderBy', 'startTime');
  url.searchParams.set('maxResults', '20');

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`Calendar events.list ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const json = await res.json() as { items?: CalendarEvent[] };
  const items = (json.items ?? []).filter(e => e.status !== 'cancelled');

  if (customerEmail) {
    const target = customerEmail.toLowerCase();
    const match = items.find(e =>
      (e.attendees ?? []).some(a => (a.email ?? '').toLowerCase() === target)
    );
    if (match) return match;
  }

  // No customer email available, or no attendee match: fall back to the
  // single closest event by start-time delta (only safe when there's
  // exactly one event in the window).
  if (items.length === 1) return items[0];
  return null;
}

/** PATCH the event's attendees array to include the new attendees. Any
 *  emails already on the list are silently de-duped. sendUpdates=all
 *  fires the standard Google Calendar invite email to the *added*
 *  attendees only. */
async function addAttendeesToCalendarEvent(
  accessToken: string,
  calendarId: string,
  eventId: string,
  existingAttendees: CalendarAttendee[],
  newAttendeeEmails: string[],
): Promise<void> {
  const existingLower = new Set(
    existingAttendees.map(a => (a.email ?? '').toLowerCase()).filter(Boolean)
  );
  const toAdd: CalendarAttendee[] = newAttendeeEmails
    .filter(e => !existingLower.has(e.toLowerCase()))
    .map(email => ({ email }));
  if (toAdd.length === 0) return;  // already on the event — no-op

  // Strip fields Google rejects on write (organizer/self echo back is
  // fine; responseStatus would force a reset of the customer's response).
  const cleanAttendees = [...existingAttendees, ...toAdd]
    .filter(a => a.email)
    .map(a => ({ email: a.email!, displayName: a.displayName, responseStatus: a.responseStatus }));

  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=all`;
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

