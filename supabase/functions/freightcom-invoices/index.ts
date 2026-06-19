// Fetch Freightcom finance documents (invoices).
// Two modes:
//   mode=shipment: GET /finance/invoices-for-shipment-id/{id}
//   mode=date_range: GET /finance/documents with a date range
//
// POST body: { mode: 'shipment'|'date_range', freightcom_shipment_id?: string, days?: number }
// Returns:   { invoices: FreightcomInvoice[] }

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

  const body = await req.json() as {
    mode?: string;
    freightcom_shipment_id?: string;
    days?: number;
  };
  const { mode, freightcom_shipment_id } = body;
  const rawDays = body.days ?? 90;
  if (typeof rawDays !== 'number' || !Number.isFinite(rawDays) || rawDays < 1 || rawDays > 365) {
    return json({ error: 'days must be a number between 1 and 365' }, 400);
  }
  const days = rawDays;

  if (mode === 'shipment') {
    if (!freightcom_shipment_id) return json({ error: 'freightcom_shipment_id required for mode=shipment' }, 400);
    if (!/^\w[\w-]*$/.test(freightcom_shipment_id)) return json({ error: 'Invalid freightcom_shipment_id' }, 400);

    const res = await fetch(`${baseUrl}/finance/invoices-for-shipment-id/${freightcom_shipment_id}`, {
      headers: { Authorization: apiKey },
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      return json({ error: 'Freightcom invoices fetch failed', details: errBody }, 502);
    }
    const invoices = await res.json();
    return json({ invoices: Array.isArray(invoices) ? invoices : [] });
  }

  if (mode === 'date_range') {
    const to   = new Date();
    const from = new Date(Date.now() - days * 86_400_000);
    const toDate   = { year: to.getUTCFullYear(),   month: to.getUTCMonth() + 1,   day: to.getUTCDate() };
    const fromDate = { year: from.getUTCFullYear(), month: from.getUTCMonth() + 1, day: from.getUTCDate() };

    const url = `${baseUrl}/finance/documents`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: fromDate, to: toDate }),
    });
    if (!res.ok) {
      // GET /finance/documents may use query params — try GET if POST fails
      const getUrl = `${baseUrl}/finance/documents?from_year=${fromDate.year}&from_month=${fromDate.month}&from_day=${fromDate.day}&to_year=${toDate.year}&to_month=${toDate.month}&to_day=${toDate.day}`;
      const getRes = await fetch(getUrl, { headers: { Authorization: apiKey } });
      if (!getRes.ok) {
        const errBody = await getRes.json().catch(() => ({}));
        return json({ error: 'Freightcom documents fetch failed', details: errBody }, 502);
      }
      const docs = await getRes.json();
      return json({ invoices: Array.isArray(docs) ? docs : [] });
    }
    const docs = await res.json();
    return json({ invoices: Array.isArray(docs) ? docs : [] });
  }

  return json({ error: 'mode must be "shipment" or "date_range"' }, 400);
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'content-type': 'application/json' },
  });
}
