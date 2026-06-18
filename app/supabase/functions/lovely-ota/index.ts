// lovely-ota — Supabase Edge Function
//
// ⚠️ DEPLOYS TO THE **LOVELY** PROJECT (ref arfdopgbvlfmhmcfghhl), NOT makelila. verify_jwt=false.
//
// Admin OTA manager. Two actions (POST body `action`):
//   - 'list'   → all ota_updates incl. inactive drafts (the public RLS only exposes
//                active ones, so this read needs the service role).
//   - 'upsert' → create a new update or edit an existing one (by id) + toggle active.
// Admin-only: validates the caller's makelila operator JWT (@virgohome.io) AND requires
// finance/admin in makelila's `profiles`. Mirrors lovely-verify-user's auth gate.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const MAKELILA_URL = 'https://txeftbbzeflequvrmjjr.supabase.co';
const MAKELILA_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR4ZWZ0YmJ6ZWZsZXF1dnJtampyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYyNzk3NjcsImV4cCI6MjA5MTg1NTc2N30.sWmDCODRuhutbHuXcoVIVRvVvVyZADpNysFkerOXNPw';

const ALLOWED_EMAIL_DOMAIN = '@virgohome.io';
const LEADERSHIP_ROLES = ['finance', 'admin'];
const OTA_COLS = 'id, version, description, release_notes, is_active, created_at, updated_at';

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

  // 2. Enforce leadership (finance/admin) server-side.
  const { data: profile, error: roleErr } = await makelila
    .from('profiles')
    .select('role')
    .eq('id', userData!.user!.id)
    .single();
  if (roleErr || !LEADERSHIP_ROLES.includes((profile?.role as string) ?? '')) {
    return json({ error: 'Forbidden — leadership only' }, 403);
  }

  const body = (await req.json().catch(() => ({}))) as {
    action?: string;
    id?: string;
    version?: string;
    description?: string | null;
    release_notes?: string | null;
    is_active?: boolean;
  };

  const lovely = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  if (body.action === 'list') {
    const { data, error } = await lovely
      .from('ota_updates')
      .select(OTA_COLS)
      .order('created_at', { ascending: false });
    if (error) {
      console.error('lovely-ota list error:', error);
      return json({ error: error.message }, 500);
    }
    return json({ updates: data ?? [] });
  }

  if (body.action === 'upsert') {
    if (!body.version || !body.version.trim()) return json({ error: 'version is required' }, 400);
    const fields = {
      version: body.version.trim(),
      description: body.description ?? null,
      release_notes: body.release_notes ?? null,
      is_active: body.is_active ?? false,
      updated_at: new Date().toISOString(),
    };
    const query = body.id
      ? lovely.from('ota_updates').update(fields).eq('id', body.id)
      : lovely.from('ota_updates').insert(fields);
    const { data, error } = await query.select(OTA_COLS).single();
    if (error) {
      console.error('lovely-ota upsert error:', error);
      const status = (error as { code?: string }).code === '23505' ? 409 : 500;
      return json({ error: error.message }, status);
    }
    return json({ update: data });
  }

  return json({ error: 'Unknown action' }, 400);
});
