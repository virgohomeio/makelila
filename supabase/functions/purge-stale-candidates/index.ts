// Enforces the decided 1-year retention policy for rejected candidates
// (PRD §4.15): purges the resume file from Storage and nulls PII columns
// on candidates rejected more than a year ago. Hired candidates are never
// touched — hired_at exclusion is the whole point. Cron-only, scheduled
// every 24h (see 20260724150100_hiring_retention_cron.sql).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { corsHeaders } from '../_shared/cors.ts';
import { authenticate } from '../_shared/auth.ts';

const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

/** Exported for unit testing without needing Date.now() timing games. */
export function isPastRetention(rejectedAt: string, now: Date): boolean {
  return now.getTime() - new Date(rejectedAt).getTime() > ONE_YEAR_MS;
}

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
  if (!supabaseUrl || !serviceKey) return json({ error: 'Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY' }, 500);

  const admin = createClient(supabaseUrl, serviceKey);
  let caller;
  try { caller = await authenticate(req, admin); }
  catch (e) { if (e instanceof Response) return e; throw e; }
  if (caller.kind !== 'cron') {
    return json({ error: 'This function is cron-only — use the X-Cron-Secret header.' }, 403);
  }

  const cutoff = new Date(Date.now() - ONE_YEAR_MS).toISOString();
  const { data: stale, error: fetchErr } = await admin
    .from('candidates')
    .select('id, resume_url')
    .lt('rejected_at', cutoff)
    .is('hired_at', null);
  if (fetchErr) return json({ error: fetchErr.message }, 500);

  let purged = 0;
  const errors: string[] = [];
  for (const row of stale ?? []) {
    try {
      // resume_url holds the raw hiring-resumes storage path directly, not
      // a resolved URL (Task 6 fix — the bucket is private, so no public
      // URL to parse). Remove it from Storage by that path as-is.
      if (row.resume_url) {
        await admin.storage.from('hiring-resumes').remove([row.resume_url]);
      }
      const { error: updateErr } = await admin.from('candidates').update({
        full_name: '[purged]', email: null, phone: null, resume_url: null,
        indeed_relay_email: null,
      }).eq('id', row.id);
      if (updateErr) { errors.push(`${row.id}: ${updateErr.message}`); continue; }
      purged++;
    } catch (e) {
      errors.push(`${row.id}: ${(e as Error).message}`);
    }
  }

  return json({ purged, errors }, 200);
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'content-type': 'application/json' } });
}
