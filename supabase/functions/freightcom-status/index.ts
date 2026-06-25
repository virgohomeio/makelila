// Batch-fetch live Freightcom shipment status and persist it.
// POST body: { shipments: [{ id, freightcom_shipment_id }] }
// Returns:   { results: [{ id, freightcom_status, error? }] }

import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const DEFAULT_BASE_URL = 'https://customer-external-api.ssd-test.freightcom.com';

async function authenticate(req: Request, admin: SupabaseClient): Promise<void> {
  const jwt = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!jwt) throw json({ error: 'Missing Authorization header' }, 401);
  const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
  if (userErr || !userData?.user) throw json({ error: 'Invalid token' }, 401);
  const { data: profile, error: pErr } = await admin
    .from('profiles').select('is_internal').eq('id', userData.user.id).maybeSingle();
  if (pErr) throw json({ error: `Profile lookup: ${pErr.message}` }, 500);
  if (!profile?.is_internal) throw json({ error: 'Not authorized' }, 403);
}

type Item = { id: string; freightcom_shipment_id: string };

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

  const { shipments } = await req.json() as { shipments?: Item[] };
  if (!Array.isArray(shipments) || shipments.length === 0) {
    return json({ error: 'shipments[] required' }, 400);
  }

  const nowIso = new Date().toISOString();
  const results: Array<{ id: string; freightcom_status: string | null; error?: string }> = [];

  for (const s of shipments) {
    if (!s?.freightcom_shipment_id || !/^\w[\w-]*$/.test(s.freightcom_shipment_id)) {
      results.push({ id: s?.id, freightcom_status: null, error: 'invalid freightcom_shipment_id' });
      continue;
    }
    try {
      const res = await fetch(`${baseUrl}/shipment/${s.freightcom_shipment_id}`, {
        headers: { Authorization: apiKey },
      });
      if (!res.ok) {
        results.push({ id: s.id, freightcom_status: null, error: `Freightcom ${res.status}` });
      } else {
        const body = await res.json() as { state?: string };
        const state = body.state ?? null;
        await admin.from('shipments')
          .update({ freightcom_status: state, status_synced_at: nowIso })
          .eq('id', s.id);
        results.push({ id: s.id, freightcom_status: state });
      }
    } catch (e) {
      results.push({ id: s.id, freightcom_status: null, error: (e as Error).message });
    }
    await new Promise(r => setTimeout(r, 200)); // throttle ~5 req/sec
  }

  return json({ results });
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, 'content-type': 'application/json' },
  });
}
