// lovely-verify-user — Supabase Edge Function
//
// ⚠️ DEPLOYS TO THE **LOVELY** PROJECT (ref arfdopgbvlfmhmcfghhl), NOT makelila. verify_jwt=false.
//
// Approves a pending Lovely-app user (is_verified=true). Admin-only:
//   1. validates the caller's makelila operator JWT (@virgohome.io), AND
//   2. requires the caller to be finance/admin in makelila's `profiles`.
// Reads makelila profiles with the caller's own token (RLS allows authenticated read);
// writes the Lovely `users` row with the Lovely service role. Mirrors lovely-users.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const MAKELILA_URL = 'https://txeftbbzeflequvrmjjr.supabase.co';
const MAKELILA_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR4ZWZ0YmJ6ZWZsZXF1dnJtampyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYyNzk3NjcsImV4cCI6MjA5MTg1NTc2N30.sWmDCODRuhutbHuXcoVIVRvVvVyZADpNysFkerOXNPw';

const ALLOWED_EMAIL_DOMAIN = '@virgohome.io';
const LEADERSHIP_ROLES = ['finance', 'admin'];

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
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  // 1. Validate the makelila operator token.
  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) return json({ error: 'Missing authorization header' }, 401);
  const token = authHeader.replace('Bearer ', '');

  const makelila = createClient(MAKELILA_URL, MAKELILA_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data: userData, error: authErr } = await makelila.auth.getUser(token);
  const email = userData?.user?.email ?? '';
  if (authErr || !email.toLowerCase().endsWith(ALLOWED_EMAIL_DOMAIN)) {
    return json({ error: 'Unauthorized' }, 401);
  }

  // 2. Enforce leadership (finance/admin) server-side, read with the caller's own token.
  const { data: profile, error: roleErr } = await makelila
    .from('profiles')
    .select('role')
    .eq('id', userData!.user!.id)
    .single();
  if (roleErr || !LEADERSHIP_ROLES.includes((profile?.role as string) ?? '')) {
    return json({ error: 'Forbidden — leadership only' }, 403);
  }

  // 3. Read body.
  const body = (await req.json().catch(() => ({}))) as { user_id?: string };
  if (!body.user_id) return json({ error: 'Missing user_id' }, 400);

  // 4. Approve via the Lovely project's own service role.
  const lovely = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );
  const nowIso = new Date().toISOString();
  const { data: updated, error: updErr } = await lovely
    .from('users')
    .update({ is_verified: true, verified_at: nowIso, updated_at: nowIso })
    .eq('id', body.user_id)
    .select('id, email, is_verified, verified_at')
    .single();
  if (updErr) {
    console.error('lovely-verify-user update error:', updErr);
    return json({ error: updErr.message }, 500);
  }

  return json({ user: updated });
});
