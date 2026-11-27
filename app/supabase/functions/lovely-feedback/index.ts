// lovely-feedback — Supabase Edge Function
//
// ⚠️ DEPLOYS TO THE **LOVELY** PROJECT (ref arfdopgbvlfmhmcfghhl), *NOT* makelila.
// Deploy with verify_jwt = FALSE, like the other lovely-* functions: the
// caller is makelila's cron, not a Lovely user, and auth is the shared secret
// checked in-body.
//
// Feeds makelila's sync-lovely-tickets cron, which turns each row of the Lovely
// app's in-app feedback (public.feedback: bug, idea or other) into a support
// ticket. That table is service-role only, so the cron can't read it with the
// anon key the way it reads damage_reports.
//
// Auth: X-Sync-Secret header must equal LOVELY_FEEDBACK_SYNC_SECRET. Set the
// same name and value on both projects:
//   supabase secrets set LOVELY_FEEDBACK_SYNC_SECRET=<value> --project-ref arfdopgbvlfmhmcfghhl
//   supabase secrets set LOVELY_FEEDBACK_SYNC_SECRET=<value> --project-ref txeftbbzeflequvrmjjr
//
// Body: none  →  { feedback: [...rows oldest first, each with the account's email] }

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// PostgREST caps a response at max_rows (1000 on hosted Supabase).
const PAGE = 1_000;
// Keeps `.in()` filters well inside URL length limits.
const IN_CHUNK = 100;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-sync-secret',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

type FeedbackRow = {
  id: string;
  user_id: string | null;
  user_name: string | null;
  serial_number: string | null;
  kind: string;
  message: string | null;
  page_path: string | null;
  user_agent: string | null;
  app_version: string | null;
  photo_path: string | null;
  created_at: string | null;
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return json({ error: 'Use POST' }, 405);
  }

  // 1. Shared-secret auth.
  const expected = Deno.env.get('LOVELY_FEEDBACK_SYNC_SECRET');
  if (!expected) {
    return json({ error: 'LOVELY_FEEDBACK_SYNC_SECRET not configured' }, 500);
  }
  if ((req.headers.get('x-sync-secret') ?? '') !== expected) {
    return json({ error: 'Bad or missing X-Sync-Secret' }, 401);
  }

  // 2. Read with the Lovely project's own service role.
  const lovely = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const rows: FeedbackRow[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await lovely
      .from('feedback')
      .select('id, user_id, user_name, serial_number, kind, message, page_path, user_agent, app_version, photo_path, created_at')
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) {
      console.error('lovely-feedback DB error:', error);
      return json({ error: error.message }, 500);
    }
    const batch = (data ?? []) as FeedbackRow[];
    rows.push(...batch);
    if (batch.length < PAGE) break;
  }

  // 3. The account email, so a sender makelila can't match to a customer still
  //    has an address CS can reply to.
  const userIds = [...new Set(rows.map(r => r.user_id).filter((id): id is string => !!id))];
  const emailById = new Map<string, string>();
  for (let i = 0; i < userIds.length; i += IN_CHUNK) {
    const { data, error } = await lovely
      .from('users')
      .select('id, email')
      .in('id', userIds.slice(i, i + IN_CHUNK));
    if (error) {
      console.error('lovely-feedback users error:', error);
      return json({ error: error.message }, 500);
    }
    for (const u of (data ?? []) as { id: string; email: string | null }[]) {
      if (u.email) emailById.set(u.id, u.email);
    }
  }

  return json({
    feedback: rows.map(r => ({ ...r, email: r.user_id ? emailById.get(r.user_id) ?? null : null })),
  });
});
