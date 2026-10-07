// Creates lightweight "stub" candidate rows from Indeed's real
// notification-email format on the shared support@virgohome.io mailbox
// (same mailbox sync-gmail-tickets already reads). Verified against real
// inbox data 2026-07-24: Indeed's per-candidate emails come from
// conversation-{name}-{id}@indeedemail.com with subject
// "[Action required] New application for {title}, {location}" — but never
// actually attach the resume (only a "View resume" link to Indeed's
// login-gated dashboard), and the sender is an Indeed relay address, not
// the candidate's real email. Real contact info + the resume file itself
// still arrive via the parse-resume-batch upload path (primary path, not
// a fallback) — see docs/PRD-2026-06-06.md §4.15.
//
// Sender filter is mutually exclusive with sync-gmail-tickets's own
// filter (GMAIL_QUERY excludes indeedemail.com/indeed.com there) so an
// applicant notification can never be double-processed as a support
// ticket.
//
// Bundled digest emails (employers-noreply@indeed.com, "X and N others
// applied") are intentionally skipped in V1 — see the test file for why.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { corsHeaders } from '../_shared/cors.ts';
import { authenticate } from '../_shared/auth.ts';
import { getGmailAccessToken, type ServiceAccountKey } from '../_shared/gmail-auth.ts';

const GMAIL_SCOPES = 'https://www.googleapis.com/auth/gmail.readonly';
const HIRING_MAILBOX = 'support@virgohome.io';
const INDEED_SUBJECT_PREFIX = '[Action required] New application for ';

export type IndeedApplication = {
  candidateName: string;
  jobTitle: string;
  relayEmail: string;
  dashboardUrl: string | null;
};

/** Parses a single Indeed per-candidate application email. Returns null
 *  for anything that isn't a real per-candidate application notification
 *  (marketing mail, non-Indeed senders, or bundled digest emails — see
 *  index.test.ts for the exact cases this excludes and why). Exported for
 *  unit testing without needing a live Gmail connection. */
export function parseIndeedNotification(
  subject: string, from: string, plaintextBody: string,
): IndeedApplication | null {
  if (!from.includes('@indeedemail.com')) return null; // excludes employers-noreply@, learn@mc., etc.
  if (!subject.startsWith(INDEED_SUBJECT_PREFIX)) return null;

  // Subject location suffix is always exactly two ", "-separated segments
  // ("City, Province Postal") — even when the job title itself contains an
  // internal comma (e.g. "... | Markham, ON (In-Person) | ..."). Stripping
  // only the last segment (lastIndexOf) leaves the city glued onto the
  // title; splitting and dropping the last two segments handles both.
  const afterPrefix = subject.slice(INDEED_SUBJECT_PREFIX.length);
  const parts = afterPrefix.split(', ');
  const jobTitle = (parts.length > 2 ? parts.slice(0, -2).join(', ') : afterPrefix).trim();
  if (!jobTitle) return null;

  const nameMatch = plaintextBody.match(/^([^\n]+?) applied to /m);
  const candidateName = nameMatch?.[1]?.trim();
  if (!candidateName) return null;

  return {
    candidateName,
    jobTitle,
    relayEmail: from,
    dashboardUrl: extractDashboardUrl(plaintextBody),
  };
}

/** Finds the employers.indeed.com candidate-view link in the email body.
 *  Indeed sometimes links it directly, and sometimes wraps it in a
 *  session-switch redirect (`account.indeed.com/.../confirm?...&continue=
 *  <percent-encoded target>`) — so each candidate URL is decoded before
 *  searching, and the plain-text case (no `%` escapes) round-trips
 *  unchanged through decodeURIComponent. */
function extractDashboardUrl(body: string): string | null {
  const NEEDLE = 'https://employers.indeed.com/candidates/view';
  const urls = body.match(/https:\/\/[^\s]+/g) ?? [];
  for (const raw of urls) {
    let decoded = raw;
    try { decoded = decodeURIComponent(raw); } catch { /* not percent-encoded */ }
    const idx = decoded.indexOf(NEEDLE);
    if (idx !== -1) return decoded.slice(idx);
  }
  return null;
}

type GmailMessage = {
  id: string;
  payload?: { headers?: { name: string; value: string }[] };
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: corsHeaders });
  try { return await handle(req); }
  catch (err) {
    return json({ error: `Uncaught: ${(err as Error)?.message ?? String(err)}` }, 500);
  }
});

async function handle(req: Request): Promise<Response> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const saKeyB64    = Deno.env.get('GOOGLE_SERVICE_ACCOUNT_KEY');
  if (!supabaseUrl || !serviceKey || !saKeyB64) {
    return json({ error: 'Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / GOOGLE_SERVICE_ACCOUNT_KEY' }, 500);
  }

  const admin = createClient(supabaseUrl, serviceKey);

  let caller;
  try { caller = await authenticate(req, admin); }
  catch (e) { if (e instanceof Response) return e; throw e; }
  if (caller.kind !== 'cron') {
    return json({ error: 'This function is cron-only — use the X-Cron-Secret header.' }, 403);
  }

  const saKey = JSON.parse(atob(saKeyB64)) as ServiceAccountKey;
  const token = await getGmailAccessToken(saKey, HIRING_MAILBOX, GMAIL_SCOPES);

  const { data: postings } = await admin.from('job_postings').select('id, title').eq('status', 'open');
  const postingsByTitle = new Map((postings ?? []).map(p => [p.title.trim(), p.id as string]));

  const query = encodeURIComponent('from:indeedemail.com newer_than:7d');
  const listRes = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/${HIRING_MAILBOX}/messages?q=${query}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!listRes.ok) return json({ error: `Gmail list ${listRes.status}: ${await listRes.text()}` }, 500);
  const { messages } = await listRes.json() as { messages?: { id: string }[] };

  let created = 0, skipped = 0;
  const errors: string[] = [];

  for (const m of messages ?? []) {
    try {
      const msgRes = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/${HIRING_MAILBOX}/messages/${m.id}?format=full`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!msgRes.ok) { errors.push(`${m.id}: fetch ${msgRes.status}`); continue; }
      const msg = await msgRes.json() as GmailMessage & { snippet?: string; payload?: { body?: { data?: string }; parts?: { mimeType?: string; body?: { data?: string } }[] } };

      const headers = msg.payload?.headers ?? [];
      const subject = headers.find(h => h.name.toLowerCase() === 'subject')?.value ?? '';
      const from = headers.find(h => h.name.toLowerCase() === 'from')?.value ?? '';
      const plainPart = msg.payload?.parts?.find(p => p.mimeType === 'text/plain')?.body?.data
        ?? msg.payload?.body?.data;
      const body = plainPart ? decodeBase64Url(plainPart) : (msg.snippet ?? '');

      const parsed = parseIndeedNotification(subject, from, body);
      if (!parsed) { skipped++; continue; }

      const postingId = postingsByTitle.get(parsed.jobTitle);
      if (!postingId) { skipped++; continue; } // no open posting matches this title — nothing to attach the stub to

      const { data: existing } = await admin
        .from('candidates')
        .select('id')
        .eq('posting_id', postingId)
        .ilike('full_name', parsed.candidateName)
        .maybeSingle();
      if (existing) { skipped++; continue; } // already have a stub or full record for this person on this posting

      const { error: insertErr } = await admin.from('candidates').insert({
        posting_id: postingId,
        full_name: parsed.candidateName,
        source: 'indeed',
        ingested_via: 'email_sync',
        enrichment_status: 'stub',
        indeed_relay_email: parsed.relayEmail,
        indeed_dashboard_url: parsed.dashboardUrl,
      });
      if (insertErr) { errors.push(`${m.id}: insert ${insertErr.message}`); continue; }
      created++;
    } catch (e) {
      errors.push(`${m.id}: ${(e as Error).message}`);
    }
  }

  return json({ created, skipped, errors }, 200);
}

function decodeBase64Url(s: string): string {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  try { return atob(b64); } catch { return ''; }
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'content-type': 'application/json' } });
}
