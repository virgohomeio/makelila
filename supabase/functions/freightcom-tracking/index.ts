// Fetch live tracking events for a Freightcom shipment.
// POST body: { freightcom_shipment_id: string }
// Returns:   { events: TrackingEvent[] }

import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

async function authenticate(req: Request, admin: SupabaseClient): Promise<void> {
  const authHeader = req.headers.get('authorization') ?? '';
  const jwt = authHeader.replace(/^Bearer\s+/i, '');
  if (!jwt) throw json({ error: 'Missing Authorization header' }, 401);
  const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
  if (userErr || !userData?.user) throw json({ error: 'Invalid token' }, 401);
  const { data: profile, error: pErr } = await admin
    .from('profiles').select('is_internal').eq('id', userData.user.id).maybeSingle();
  if (pErr) throw json({ error: `Profile lookup: ${pErr.message}` }, 500);
  if (!profile?.is_internal) throw json({ error: 'Not authorized' }, 403);
}

const DEFAULT_BASE_URL = 'https://customer-external-api.ssd-test.freightcom.com';

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: corsHeaders });
  try { return await handle(req); }
  catch (err) {
    if (err instanceof Response) return err;
    return json({ error: `Uncaught: ${(err as Error)?.message ?? String(err)}` }, 500);
  }
});

async function handle(req: Request): Promise<Response> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const apiKey      = Deno.env.get('FREIGHTCOM_API_KEY');
  const baseUrl     = Deno.env.get('FREIGHTCOM_BASE_URL') ?? DEFAULT_BASE_URL;

  if (!apiKey) return json({ error: 'FREIGHTCOM_API_KEY not configured' }, 500);

  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  await authenticate(req, admin);

  const { freightcom_shipment_id } = await req.json() as { freightcom_shipment_id?: string };
  if (!freightcom_shipment_id) return json({ error: 'freightcom_shipment_id required' }, 400);

  const res = await fetch(`${baseUrl}/shipment/${freightcom_shipment_id}/tracking-events`, {
    headers: { Authorization: apiKey },
  });

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    return json({ error: 'Freightcom tracking fetch failed', details: errBody }, 502);
  }

  const body = await res.json() as { events?: unknown[] };
  return json({ events: body.events ?? [] });
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'content-type': 'application/json' },
  });
}
