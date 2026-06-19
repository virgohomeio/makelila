// Pull "LILA Diagnosis Chat" events from Huayi's Google Calendar and upsert
// them into service_tickets (category='diagnosis_call', source='google_calendar')
// so the Follow-Ups calendar renders them. Dedupe by google_calendar_event_id
// (unique partial index), plus a soft dedupe against diagnosis tickets that
// already came in via Calendly (same customer email + start within ±15 min).
//
// ticket_number is filled by the assign_ticket_number BEFORE INSERT trigger
// (ST-YYYY-NNNN) when null — so it's intentionally omitted from the payload.
//
// Cron-only: rejects non-cron callers via the shared authenticate() guard
// (X-Cron-Secret header matching CRON_SHARED_SECRET).
//
// Env:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  (standard)
//   CRON_SHARED_SECRET                        (cron auth)
//   GOOGLE_SERVICE_ACCOUNT_KEY                (base64 SA JSON, calendar.events DWD)
//   DIAGNOSIS_CALENDAR_MAILBOX                (delegated mailbox; default huayi@virgohome.io)
//   DIAGNOSIS_EVENT_NAME_MATCH                (title substring; default "LILA Diagnosis Chat")

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { corsHeaders } from '../_shared/cors.ts';
import { authenticate } from '../_shared/auth.ts';
import { getCalendarAccessToken, listCalendarEvents, type ServiceAccountKey } from '../_shared/google-calendar.ts';
import { matchesDiagnosisTitle, isDuplicateOf } from './dedupe.ts';

const TITLE_MATCH = Deno.env.get('DIAGNOSIS_EVENT_NAME_MATCH') ?? 'LILA Diagnosis Chat';
const CAL_MAILBOX = Deno.env.get('DIAGNOSIS_CALENDAR_MAILBOX') ?? 'huayi@virgohome.io';

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
  const saKeyB64 = Deno.env.get('GOOGLE_SERVICE_ACCOUNT_KEY');
  if (!supabaseUrl || !serviceKey || !saKeyB64) {
    return new Response(
      JSON.stringify({ error: 'Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / GOOGLE_SERVICE_ACCOUNT_KEY' }),
      { status: 500, headers: { ...corsHeaders, 'content-type': 'application/json' } },
    );
  }

  const sb = createClient(supabaseUrl, serviceKey);

  let _caller;
  try { _caller = await authenticate(req, sb); }
  catch (e) { if (e instanceof Response) return e; throw e; }
  // Reject UI-triggered calls — this function only runs from pg_cron.
  if (_caller.kind !== 'cron') {
    return new Response(
      JSON.stringify({ error: 'This function is cron-only — use the X-Cron-Secret header.' }),
      { status: 403, headers: { ...corsHeaders, 'content-type': 'application/json' } },
    );
  }

  const saKey = JSON.parse(atob(saKeyB64)) as ServiceAccountKey;
  const token = await getCalendarAccessToken(saKey, CAL_MAILBOX);

  const now = Date.now();
  const timeMin = new Date(now - 7 * 86_400_000).toISOString();
  const timeMax = new Date(now + 60 * 86_400_000).toISOString();
  const events = await listCalendarEvents(token, 'primary', timeMin, timeMax);

  const { data: existing } = await sb.from('service_tickets')
    .select('customer_email, calendly_event_start, google_calendar_event_id')
    .eq('category', 'diagnosis_call')
    .gte('calendly_event_start', timeMin);
  const existingRows = (existing ?? []) as Array<{ customer_email: string | null; calendly_event_start: string | null; google_calendar_event_id: string | null }>;

  let scanned = 0, matched = 0, upserted = 0, skipped = 0;
  for (const ev of events) {
    scanned++;
    if (!matchesDiagnosisTitle(ev.summary, TITLE_MATCH)) continue;
    const startIso = ev.start?.dateTime ?? (ev.start?.date ? `${ev.start.date}T00:00:00Z` : null);
    if (!ev.id || !startIso) { skipped++; continue; }
    matched++;
    const attendee = (ev.attendees ?? []).find(a => !a.organizer && !a.self);
    const email = attendee?.email?.toLowerCase() ?? null;
    const name = attendee?.displayName ?? attendee?.email ?? null;
    const alreadyById = existingRows.some(r => r.google_calendar_event_id === ev.id);
    if (!alreadyById && isDuplicateOf({ email, startIso }, existingRows)) { skipped++; continue; }
    const { error } = await sb.from('service_tickets').upsert({
      // ticket_number omitted: assign_ticket_number trigger fills it on insert.
      category: 'diagnosis_call', source: 'google_calendar', status: 'call_scheduled',
      priority: 'normal',
      google_calendar_event_id: ev.id, calendly_event_start: startIso,
      subject: ev.summary ?? 'LILA Diagnosis Chat',
      customer_email: email, customer_name: name,
    }, { onConflict: 'google_calendar_event_id' });
    if (error) { skipped++; continue; }
    upserted++;
  }
  return new Response(
    JSON.stringify({ scanned, matched, upserted, skipped }),
    { status: 200, headers: { ...corsHeaders, 'content-type': 'application/json' } },
  );
}
