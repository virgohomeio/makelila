// Fetch live shipping rate quotes from the Freightcom API for a given order.
// Uses async polling: POST /rate returns a request_id, then GET /rate/{id}
// is polled until done=true.  All returned rates are stored in freight_quotes.
//
// Env vars required:
//   FREIGHTCOM_API_KEY       — Bearer token (Authorization header)
//   FREIGHTCOM_BASE_URL      — defaults to test env URL below
//   SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY  (auto-injected)

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
    .from('profiles')
    .select('is_internal')
    .eq('id', userData.user.id)
    .maybeSingle();
  if (pErr) throw json({ error: `Profile lookup: ${pErr.message}` }, 500);
  if (!profile?.is_internal) throw json({ error: 'Not authorized' }, 403);
}

const DEFAULT_BASE_URL = 'https://customer-external-api.ssd-test.freightcom.com';

// VCycene warehouse — origin for all shipments
const ORIGIN_POSTAL  = 'L3R9Z7';
const ORIGIN_COUNTRY = 'CA';

// LILA Composter default dimensions (used when caller doesn't specify packages)
const DEFAULT_PACKAGES = [
  { weight_kg: 23, length_cm: 61, width_cm: 61, height_cm: 61, description: 'LILA Composter' },
];

const POLL_MAX_TRIES   = 20;
const POLL_INTERVAL_MS = 2000;

type FreightcomPackageInput = {
  weight_kg: number;
  length_cm: number;
  width_cm: number;
  height_cm: number;
  description?: string;
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders });
  }
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

  const body = await req.json();
  const { order_id, ship_date, packages: pkgOverrides } = body as {
    order_id?: string;
    ship_date?: { year: number; month: number; day: number };
    packages?: FreightcomPackageInput[];
  };

  if (!order_id) return json({ error: 'order_id required' }, 400);

  // Load order destination
  const { data: order, error: orderErr } = await admin
    .from('orders')
    .select('id, address_postal_code, country')
    .eq('id', order_id)
    .single();
  if (orderErr || !order) return json({ error: 'Order not found' }, 404);

  const destPostal = (order.address_postal_code as string | null)?.replace(/\s/g, '');
  if (!destPostal) return json({ error: 'Order has no destination postal code' }, 400);

  // Default ship date = next business day (tomorrow)
  const tomorrow  = new Date(Date.now() + 86_400_000);
  const dateObj   = ship_date ?? {
    year:  tomorrow.getUTCFullYear(),
    month: tomorrow.getUTCMonth() + 1,
    day:   tomorrow.getUTCDate(),
  };

  const pkgs = (pkgOverrides ?? DEFAULT_PACKAGES).map((p) => ({
    measurements: {
      weight: { unit: 'kg', value: p.weight_kg },
      cuboid: { unit: 'cm', l: p.length_cm, w: p.width_cm, h: p.height_cm },
    },
    description: p.description ?? 'LILA Composter',
  }));

  // POST /rate — initiates async rate calculation
  const rateReq = {
    details: {
      expected_ship_date: dateObj,
      packaging_type: 'package',
      packaging_properties: { packages: pkgs },
      origin: {
        address: { postal_code: ORIGIN_POSTAL, country: ORIGIN_COUNTRY },
      },
      destination: {
        address: {
          postal_code: destPostal,
          country: (order.country as string) === 'US' ? 'US' : 'CA',
        },
        signature_requirement: 'not-required',
      },
    },
  };

  const initRes = await fetch(`${baseUrl}/rate`, {
    method: 'POST',
    headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(rateReq),
  });

  if (initRes.status !== 202) {
    const errBody = await initRes.json().catch(() => ({}));
    return json({ error: 'Freightcom rate request failed', details: errBody }, 502);
  }

  const { request_id } = await initRes.json() as { request_id: string };

  // Poll GET /rate/{request_id} until done
  let rates: unknown[] = [];
  for (let i = 0; i < POLL_MAX_TRIES; i++) {
    await delay(POLL_INTERVAL_MS);
    const pollRes = await fetch(`${baseUrl}/rate/${request_id}`, {
      headers: { Authorization: apiKey },
    });
    if (!pollRes.ok) break;
    const pollData = await pollRes.json() as { status?: { done: boolean }; rates?: unknown[] };
    rates = pollData.rates ?? [];
    if (pollData.status?.done) break;
  }

  // Clear existing unselected Freightcom quotes so re-quoting is clean
  await admin
    .from('freight_quotes')
    .delete()
    .eq('order_id', order_id)
    .eq('provider', 'freightcom')
    .eq('selected', false);

  // Insert all returned quotes
  const inserted: unknown[] = [];
  for (const rate of rates as Record<string, unknown>[]) {
    const total    = rate.total as { value?: string; currency?: string } | undefined;
    const cents    = parseInt(total?.value ?? '0', 10);
    const isCad    = total?.currency === 'CAD';
    const isUsd    = total?.currency === 'USD';
    const rateCad  = isCad ? cents / 100 : null;
    const rateUsd  = isUsd ? cents / 100 : null;
    const days     = (rate.transit_time_not_available as boolean)
      ? null
      : (rate.transit_time_days as number | null) ?? null;
    const carrier  = (rate.carrier_name  as string) ?? '';
    const service  = (rate.service_name  as string) ?? '';

    const { data: row } = await admin
      .from('freight_quotes')
      .insert({
        order_id,
        provider:      'freightcom',
        service_level: `${carrier} — ${service}`,
        rate_cad:      rateCad,
        rate_usd:      rateUsd,
        transit_days:  days,
        raw:           rate,
      })
      .select()
      .single();
    if (row) inserted.push(row);
  }

  return json({ quotes: inserted, count: inserted.length });
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'content-type': 'application/json' },
  });
}
