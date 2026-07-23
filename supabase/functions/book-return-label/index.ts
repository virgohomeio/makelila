// book-return-label (FR-13): one-click return-shipping label + courier pickup.
// Isolated from the outbound freightcom-book so it can never regress outbound
// fulfilment. Quotes AND books in a single call, in the RETURN direction:
// origin = customer address, destination = VCycene warehouse. Stores a
// shipments row (raw_payload.direction='return') and stamps the return's
// pickup_carrier / pickup_tracking / pickup_date, advancing it to
// 'pickup_scheduled'.
//
// POST body: { return_id: string }
// Returns:   { label_url, tracking, carrier, service, shipment_id }
//
// Env: FREIGHTCOM_API_KEY, FREIGHTCOM_BASE_URL (defaults to test),
//      FREIGHTCOM_PAYMENT_METHOD_ID, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const DEFAULT_BASE_URL = 'https://customer-external-api.ssd-test.freightcom.com';
const WAREHOUSE_POSTAL  = 'L3R9Z7';   // VCycene warehouse — the RETURN destination
const WAREHOUSE_COUNTRY = 'CA';
const DEFAULT_PACKAGES = [
  { weight_kg: 23, length_cm: 61, width_cm: 61, height_cm: 61, description: 'LILA Composter (return)' },
];
const POLL_MAX_TRIES = 20;
const POLL_INTERVAL_MS = 2000;
const STATUS_MAP: Record<string, string> = {
  'waiting-for-transit': 'booked', 'in-transit': 'in_transit', 'delivered': 'delivered',
  'exception': 'exception', 'missing': 'missing', 'cancelled': 'cancelled',
};

async function authenticate(req: Request, admin: SupabaseClient): Promise<string> {
  const jwt = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!jwt) throw json({ error: 'Missing Authorization header' }, 401);
  const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
  if (userErr || !userData?.user) throw json({ error: 'Invalid token' }, 401);
  const { data: profile } = await admin.from('profiles').select('is_internal').eq('id', userData.user.id).maybeSingle();
  if (!profile?.is_internal) throw json({ error: 'Not authorized' }, 403);
  return userData.user.id;
}

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
  const paymentMethodId = Deno.env.get('FREIGHTCOM_PAYMENT_METHOD_ID');
  if (!apiKey)          return json({ error: 'FREIGHTCOM_API_KEY not configured' }, 500);
  if (!paymentMethodId) return json({ error: 'FREIGHTCOM_PAYMENT_METHOD_ID not configured' }, 500);

  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const userId = await authenticate(req, admin);

  const { return_id } = await req.json() as { return_id?: string };
  if (!return_id) return json({ error: 'return_id required' }, 400);

  // Load the return + resolve the customer's origin address from the linked order.
  const { data: ret, error: rErr } = await admin
    .from('returns')
    .select('id, original_order_ref, customer_name, status')
    .eq('id', return_id)
    .single();
  if (rErr || !ret) return json({ error: 'Return not found' }, 404);

  let originPostal: string | null = null;
  let originCountry = 'CA';
  let orderId: string | null = null;
  if (ret.original_order_ref) {
    const { data: order } = await admin
      .from('orders')
      .select('id, address_postal_code, country')
      .eq('order_ref', ret.original_order_ref)
      .maybeSingle();
    if (order) {
      orderId = order.id as string;
      originPostal = (order.address_postal_code as string | null)?.replace(/\s/g, '') ?? null;
      originCountry = (order.country as string) === 'US' ? 'US' : 'CA';
    }
  }
  if (!originPostal) {
    return json({ error: 'No customer postal code on file for this return (link an order with an address first).' }, 400);
  }

  const tomorrow = new Date(Date.now() + 86_400_000);
  const shipDate = { year: tomorrow.getUTCFullYear(), month: tomorrow.getUTCMonth() + 1, day: tomorrow.getUTCDate() };
  const pkgs = DEFAULT_PACKAGES.map(p => ({
    measurements: { weight: { unit: 'kg', value: p.weight_kg }, cuboid: { unit: 'cm', l: p.length_cm, w: p.width_cm, h: p.height_cm } },
    description: p.description,
  }));

  // RETURN direction: origin = customer, destination = warehouse.
  const details = {
    expected_ship_date: shipDate,
    packaging_type: 'package',
    packaging_properties: { packages: pkgs },
    origin:      { address: { postal_code: originPostal, country: originCountry } },
    destination: { address: { postal_code: WAREHOUSE_POSTAL, country: WAREHOUSE_COUNTRY }, signature_requirement: 'not-required' },
  };

  // 1. POST /rate → poll → cheapest rate
  const rateRes = await fetch(`${baseUrl}/rate`, {
    method: 'POST', headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ details }),
  });
  if (rateRes.status !== 202) {
    return json({ error: 'Freightcom rate request failed', details: await rateRes.json().catch(() => ({})) }, 502);
  }
  const { request_id } = await rateRes.json() as { request_id: string };
  let rates: Record<string, unknown>[] = [];
  for (let i = 0; i < POLL_MAX_TRIES; i++) {
    await delay(POLL_INTERVAL_MS);
    const pollRes = await fetch(`${baseUrl}/rate/${request_id}`, { headers: { Authorization: apiKey } });
    if (!pollRes.ok) break;
    const pollData = await pollRes.json() as { status?: { done: boolean }; rates?: Record<string, unknown>[] };
    rates = pollData.rates ?? [];
    if (pollData.status?.done) break;
  }
  if (!rates.length) return json({ error: 'No return-shipping rates available for this address.' }, 502);

  const cheapest = rates.reduce((a, b) => {
    const av = parseInt((a.total as { value?: string })?.value ?? '999999999', 10);
    const bv = parseInt((b.total as { value?: string })?.value ?? '999999999', 10);
    return bv < av ? b : a;
  });
  const serviceId = cheapest.service_id as string | undefined;
  if (!serviceId) return json({ error: 'Cheapest rate missing service_id' }, 502);
  const carrier = (cheapest.carrier_name as string) ?? '';
  const service = (cheapest.service_name as string) ?? '';
  const total = cheapest.total as { value?: string; currency?: string } | undefined;
  const rateCad = total?.currency === 'CAD' ? parseInt(total.value ?? '0', 10) / 100 : null;
  const transitDays = (cheapest.transit_time_not_available as boolean) ? null : (cheapest.transit_time_days as number | null) ?? null;

  // 2. POST /shipment → poll → label
  const bookRes = await fetch(`${baseUrl}/shipment`, {
    method: 'POST', headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ unique_id: `return-${return_id}`, payment_method_id: paymentMethodId, service_id: serviceId, details }),
  });
  const bookBody = await bookRes.json().catch(() => ({}) as { id?: string });
  if (bookRes.status !== 202) return json({ error: 'Freightcom booking failed', details: bookBody }, 502);
  const fcShipmentId = (bookBody as { id?: string }).id;
  if (!fcShipmentId) return json({ error: 'Freightcom did not return a shipment id' }, 502);

  let shipmentData: Record<string, unknown> | null = null;
  for (let i = 0; i < POLL_MAX_TRIES; i++) {
    await delay(POLL_INTERVAL_MS);
    const pollRes = await fetch(`${baseUrl}/shipment/${fcShipmentId}`, { headers: { Authorization: apiKey } });
    if (pollRes.status === 200) {
      const body = await pollRes.json() as { shipment?: Record<string, unknown> };
      if (!body.shipment) return json({ error: 'Freightcom returned empty shipment on 200' }, 502);
      shipmentData = body.shipment; break;
    }
    if (pollRes.status !== 202) return json({ error: `Freightcom poll error ${pollRes.status}`, details: await pollRes.json().catch(() => ({})) }, 502);
  }
  if (!shipmentData) return json({ error: 'Freightcom shipment polling timed out' }, 502);

  const labels = (shipmentData.labels ?? []) as Array<{ size: string; format: string; url: string }>;
  const labelUrl = (labels.find(l => l.format === 'pdf' && l.size === 'letter') ?? labels.find(l => l.format === 'pdf'))?.url ?? null;
  const trackingNumber = (shipmentData.primary_tracking_number as string) ?? null;
  const status = STATUS_MAP[(shipmentData.state as string) ?? 'waiting-for-transit'] ?? 'booked';

  // 3. Persist: shipments row (direction='return') + stamp the return's pickup.
  const { data: shipment } = await admin.from('shipments').insert({
    order_id: orderId,
    freightcom_shipment_id: fcShipmentId,
    carrier, service, rate_cad: rateCad, transit_days: transitDays,
    label_url: labelUrl, primary_tracking_number: trackingNumber, status, booked_by: userId,
    raw_payload: { direction: 'return', ship_from_name: ret.customer_name, ship_to_name: 'VCycene Inc.', return_id },
  }).select('id').single();

  await admin.from('returns').update({
    pickup_carrier: carrier,
    pickup_tracking: trackingNumber,
    pickup_date: `${shipDate.year}-${String(shipDate.month).padStart(2, '0')}-${String(shipDate.day).padStart(2, '0')}`,
    // Generating the label schedules the pickup — advance an intake return.
    status: ret.status === 'created' ? 'pickup_scheduled' : ret.status,
  }).eq('id', return_id);

  return json({ label_url: labelUrl, tracking: trackingNumber, carrier, service, shipment_id: (shipment as { id?: string } | null)?.id ?? fcShipmentId });
}

function delay(ms: number) { return new Promise(r => setTimeout(r, ms)); }
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'content-type': 'application/json' } });
}
