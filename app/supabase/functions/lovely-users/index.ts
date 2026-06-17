// lovely-users — Supabase Edge Function
//
// ⚠️ DEPLOYS TO THE **LOVELY** PROJECT (ref arfdopgbvlfmhmcfghhl), *NOT* makelila.
// The source lives in the makelila repo for cohesion, but any deploy
// (`supabase functions deploy` or the Supabase MCP) MUST target arfdopgbvlfmhmcfghhl.
//
// Returns the Lovely app `public.users` list to authenticated makelila operators
// only. That table is PII and is intentionally NOT anon-readable. This function
// reads it with the Lovely project's own service-role key, and gates access by
// validating the caller's *makelila* operator JWT against makelila's auth server.
//
// Deploy with verify_jwt = FALSE: the incoming token is a makelila JWT (not a
// Lovely JWT), so the gateway must not pre-verify it — auth is enforced in-body.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Public (non-secret) makelila project values — they already ship in the makelila
// frontend bundle. Used only to validate operator tokens against makelila auth.
const MAKELILA_URL = 'https://txeftbbzeflequvrmjjr.supabase.co';
const MAKELILA_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR4ZWZ0YmJ6ZWZsZXF1dnJtampyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYyNzk3NjcsImV4cCI6MjA5MTg1NTc2N30.sWmDCODRuhutbHuXcoVIVRvVvVyZADpNysFkerOXNPw';

const ALLOWED_EMAIL_DOMAIN = '@virgohome.io';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  // 1. Require + validate the makelila operator token.
  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return json({ error: 'Missing authorization header' }, 401);
  }
  const token = authHeader.replace('Bearer ', '');

  const makelila = createClient(MAKELILA_URL, MAKELILA_ANON_KEY);
  const { data: userData, error: authErr } = await makelila.auth.getUser(token);
  const email = userData?.user?.email ?? '';
  if (authErr || !email.toLowerCase().endsWith(ALLOWED_EMAIL_DOMAIN)) {
    return json({ error: 'Unauthorized' }, 401);
  }

  // 2. Read the Lovely users with the Lovely project's own service role
  //    (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are auto-provided in the env).
  const lovely = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const { data: users, error: dbErr } = await lovely
    .from('users')
    .select(
      'id, email, first_name, last_name, serial_number, onboarding_step, is_verified, verified_at, mailing_list, last_login_at, login_count, created_at, updated_at',
    )
    .order('last_login_at', { ascending: false, nullsFirst: false });

  if (dbErr) {
    console.error('lovely-users DB error:', dbErr);
    return json({ error: dbErr.message }, 500);
  }

  return json({ users: users ?? [] });
});
