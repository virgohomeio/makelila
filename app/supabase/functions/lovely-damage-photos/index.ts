// lovely-damage-photos — Supabase Edge Function
//
// ⚠️ DEPLOYS TO THE **LOVELY** PROJECT (ref arfdopgbvlfmhmcfghhl), *NOT* makelila.
// Deploy with verify_jwt = FALSE (same reason as lovely-users: the incoming
// token is a makelila JWT, so auth is enforced in-body).
//
// Backs the Lovely → Tickets tab and the photos on Lovely app support tickets.
// Customer damage-report photos live in the PRIVATE `damage-photos` bucket and
// in-app feedback screenshots in the PRIVATE `feedback-photos` bucket; this
// mints short-lived signed URLs for them, for authenticated makelila operators
// only.
//
// Body: { paths: string[], bucket?: 'damage-photos' | 'feedback-photos' }
//   →  { urls: { [path]: signedUrl } }
// `bucket` defaults to damage-photos, so callers predating it are unchanged.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Public (non-secret) makelila project values — see lovely-users.
const MAKELILA_URL = 'https://txeftbbzeflequvrmjjr.supabase.co';
const MAKELILA_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR4ZWZ0YmJ6ZWZsZXF1dnJtampyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYyNzk3NjcsImV4cCI6MjA5MTg1NTc2N30.sWmDCODRuhutbHuXcoVIVRvVvVyZADpNysFkerOXNPw';

const ALLOWED_EMAIL_DOMAIN = '@virgohome.io';
// The only buckets this will sign from. Anything else is a 400, so the
// function can't be pointed at an arbitrary bucket.
const BUCKETS = ['damage-photos', 'feedback-photos'];
const DEFAULT_BUCKET = 'damage-photos';
const EXPIRES_IN_SECONDS = 60 * 60;
const MAX_PATHS = 200;

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

  // 2. Validate input.
  let paths: unknown;
  let bucket: unknown;
  try {
    ({ paths, bucket = DEFAULT_BUCKET } = await req.json());
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }
  if (!Array.isArray(paths) || !paths.every(p => typeof p === 'string' && p.length > 0)) {
    return json({ error: '`paths` must be a non-empty string array' }, 400);
  }
  if (paths.length > MAX_PATHS) {
    return json({ error: `At most ${MAX_PATHS} paths per request` }, 400);
  }
  if (typeof bucket !== 'string' || !BUCKETS.includes(bucket)) {
    return json({ error: `\`bucket\` must be one of: ${BUCKETS.join(', ')}` }, 400);
  }

  // 3. Sign with the Lovely project's own service role.
  const lovely = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );
  const { data, error } = await lovely.storage
    .from(bucket)
    .createSignedUrls(paths as string[], EXPIRES_IN_SECONDS);
  if (error) {
    console.error('lovely-damage-photos sign error:', error);
    return json({ error: error.message }, 500);
  }

  const urls: Record<string, string> = {};
  for (const item of data ?? []) {
    if (item.path && item.signedUrl) urls[item.path] = item.signedUrl;
  }
  return json({ urls });
});
