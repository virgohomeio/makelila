// Book a shipment via Freightcom: POST /shipment → poll GET /shipment/{id}
// until the response is HTTP 200 → extract label URL + tracking number →
// insert into shipments table.
//
// POST body: { order_id: string, quote_id: string }
// Returns:   { shipment: Shipment }
//
// Env vars (all auto-injected or set via supabase secrets set):
//   FREIGHTCOM_API_KEY            — bare token, no "Bearer" prefix
//   FREIGHTCOM_BASE_URL           — defaults to test env
//   FREIGHTCOM_PAYMENT_METHOD_ID  — from GET /finance/payment-methods
//   SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY

import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

async function authenticate(req: Request, admin: SupabaseClient): Promise<string> {
  const authHeader = req.headers.get('authorization') ?? '';
  const jwt = authHeader.replace(/^Bearer\s+/i, '');
  if (!jwt) throw json({ error: 'Missing Authorization header' }, 401);
  const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
  if (userErr || !userData?.user) throw json({ error: 'Invalid token' }, 401);
  const { data: profile, error: pErr } = await admin
    .from('profiles').select('is_internal').eq('id', userData.user.id).maybeSingle();
  if (pErr) throw json({ error: `Profile lookup: ${pErr.message}` }, 500);
  if (!profile?.is_internal) throw json({ error: 'Not authorized' }, 403);
  return userData.user.id;
}

const DEFAULT_BASE_URL = 'https://customer-external-api.ssd-test.freightcom.com';
const ORIGIN_POSTAL  = 'L3R9Z7';
const ORIGIN_COUNTRY = 'CA';
const DEFAULT_PACKAGES = [
  { weight_kg: 23, length_cm: 61, width_cm: 61, height_cm: 61, description: 'LILA Composter' },
];
const POLL_MAX_TRIES   = 20;
const POLL_INTERVAL_MS = 2000;

const STATUS_MAP: Record<string, string> = {
  'waiting-for-transit': 'booked',
  'in-transit':          'in_transit',
  'delivered':           'delivered',
  'exception':           'exception',
  'missing':             'missing',
  'cancelled':           'cancelled',
};

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
  const supabaseUrl    = Deno.env.get('SUPABASE_URL')!;
  const serviceKey     = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const apiKey         = Deno.env.get('FREIGHTCOM_API_KEY');
  const baseUrl        = Deno.env.get('FREIGHTCOM_BASE_URL') ?? DEFAULT_BASE_URL;
  const paymentMethodId = Deno.env.get('FREIGHTCOM_PAYMENT_METHOD_ID');

  if (!apiKey)          return json({ error: 'FREIGHTCOM_API_KEY not configured' }, 500);
  if (!paymentMethodId) return json({ error: 'FREIGHTCOM_PAYMENT_METHOD_ID not configured' }, 500);

  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const userId = await authenticate(req, admin);

  const { order_id, quote_id } = await req.json() as { order_id?: string; quote_id?: string };
  if (!order_id) return json({ error: 'order_id required' }, 400);
  if (!quote_id) return json({ error: 'quote_id required' }, 400);

  // Load selected quote — service_id is inside raw JSON
  const { data: quote, error: qErr } = await admin
    .from('freight_quotes')
    .select('id, service_level, rate_cad, transit_days, raw')
    .eq('id', quote_id)
    .eq('order_id', order_id)
    .single();
  if (qErr || !quote) return json({ error: 'Quote not found' }, 404);

  const serviceId = (quote.raw as Record<string, unknown>)?.service_id as string | undefined;
  if (!serviceId) return json({ error: 'Quote raw data missing service_id' }, 400);

  // Load order destination
  const { data: order, error: oErr } = await admin
    .from('orders')
    .select('id, address_postal_code, country')
    .eq('id', order_id)
    .single();
  if (oErr || !order) return json({ error: 'Order not found' }, 404);

  const destPostal = (order.address_postal_code as string | null)?.replace(/\s/g, '');
  if (!destPostal) return json({ error: 'Order has no destination postal code' }, 400);

  // Build ship date (tomorrow)
  const tomorrow = new Date(Date.now() + 86_400_000);
  const shipDate = { year: tomorrow.getUTCFullYear(), month: tomorrow.getUTCMonth() + 1, day: tomorrow.getUTCDate() };

  const pkgs = DEFAULT_PACKAGES.map(p => ({
    measurements: {
      weight: { unit: 'kg', value: p.weight_kg },
      cuboid: { unit: 'cm', l: p.length_cm, w: p.width_cm, h: p.height_cm },
    },
    description: p.description,
  }));

  // POST /shipment
  const bookReq = {
    unique_id: quote_id,  // idempotency key — same quote can't be double-booked
    payment_method_id: paymentMethodId,
    service_id: serviceId,
    details: {
      expected_ship_date: shipDate,
      packaging_type: 'package',
      packaging_properties: { packages: pkgs },
      origin: { address: { postal_code: ORIGIN_POSTAL, country: ORIGIN_COUNTRY } },
      destination: {
        address: { postal_code: destPostal, country: order.country === 'US' ? 'US' : 'CA' },
        signature_requirement: 'not-required',
      },
    },
  };

  const bookRes = await fetch(`${baseUrl}/shipment`, {
    method: 'POST',
    headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(bookReq),
  });

  if (bookRes.status !== 202) {
    const errBody = await bookRes.json().catch(() => ({}));
    return json({ error: 'Freightcom booking failed', details: errBody }, 502);
  }

  const { id: fcShipmentId } = await bookRes.json() as { id: string };

  // Poll GET /shipment/{id} until HTTP 200 (202 = still processing)
  let shipmentData: Record<string, unknown> | null = null;
  for (let i = 0; i < POLL_MAX_TRIES; i++) {
    await delay(POLL_INTERVAL_MS);
    const pollRes = await fetch(`${baseUrl}/shipment/${fcShipmentId}`, {
      headers: { Authorization: apiKey },
    });
    if (pollRes.status === 200) {
      const body = await pollRes.json() as { shipment: Record<string, unknown> };
      shipmentData = body.shipment ?? null;
      break;
    }
    // 202 = still processing, keep polling
  }

  if (!shipmentData) {
    return json({ error: 'Freightcom shipment polling timed out' }, 502);
  }

  // Extract label URL (prefer letter-size PDF)
  const labels = (shipmentData.labels ?? []) as Array<{ size: string; format: string; url: string }>;
  const labelEntry =
    labels.find(l => l.format === 'pdf' && l.size === 'letter') ??
    labels.find(l => l.format === 'pdf') ??
    null;
  const labelUrl          = labelEntry?.url ?? null;
  const trackingNumber    = (shipmentData.primary_tracking_number as string) ?? null;
  const fcState           = (shipmentData.state as string) ?? 'waiting-for-transit';
  const status            = STATUS_MAP[fcState] ?? 'booked';

  // Parse carrier + service from the quote's service_level ("Carrier — Service")
  const parts = (quote.service_level as string).split(' — ');
  const carrier = parts[0] ?? '';
  const service = parts[1] ?? quote.service_level;

  // Insert shipments row
  const { data: shipment, error: insertErr } = await admin
    .from('shipments')
    .insert({
      order_id,
      freightcom_shipment_id: fcShipmentId,
      carrier,
      service,
      rate_cad:                quote.rate_cad,
      transit_days:            quote.transit_days,
      label_url:               labelUrl,
      primary_tracking_number: trackingNumber,
      status,
      booked_by:               userId,
    })
    .select()
    .single();

  if (insertErr) return json({ error: `DB insert failed: ${insertErr.message}` }, 500);

  return json({ shipment });
}

function delay(ms: number) { return new Promise(r => setTimeout(r, ms)); }
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'content-type': 'application/json' },
  });
}
