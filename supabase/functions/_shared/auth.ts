import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

// Security pass Phase 3b (spec: docs/superpowers/specs/2026-06-03-security-pass-design.md).
// Shared authentication wrapper for every edge function.
//
// Accepts either:
//   1. X-Cron-Secret header matching the CRON_SHARED_SECRET env var (cron path)
//   2. Authorization: Bearer <jwt> that resolves to a profiles.is_internal=true
//      user (operator path)
//
// Returns the Caller on success; throws a fully-formed Response on failure
// (the handler should `if (e instanceof Response) return e`).

export type Caller =
  | { kind: 'cron' }
  | { kind: 'user'; user_id: string; email: string };

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

export async function authenticate(req: Request, admin: SupabaseClient): Promise<Caller> {
  // Path 1: cron-secret header set by pg_cron.invoke_edge_function (Phase 3a).
  const cronSecret = Deno.env.get('CRON_SHARED_SECRET');
  const cronHeader = req.headers.get('x-cron-secret');
  if (cronHeader && cronSecret && cronHeader === cronSecret) {
    return { kind: 'cron' };
  }

  // Path 2: user JWT.
  const authHeader = req.headers.get('authorization') ?? '';
  const jwt = authHeader.replace(/^Bearer\s+/i, '');
  if (!jwt) throw jsonError(401, 'Missing Authorization header');

  const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
  if (userErr || !userData?.user) throw jsonError(401, 'Invalid token');

  const { data: profile, error: pErr } = await admin
    .from('profiles')
    .select('is_internal')
    .eq('id', userData.user.id)
    .maybeSingle();
  if (pErr) throw jsonError(500, `Profile lookup: ${pErr.message}`);
  if (!profile?.is_internal) throw jsonError(403, 'Not authorized');

  return {
    kind: 'user',
    user_id: userData.user.id,
    email: userData.user.email ?? '',
  };
}

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...corsHeaders, 'content-type': 'application/json' },
  });
}
