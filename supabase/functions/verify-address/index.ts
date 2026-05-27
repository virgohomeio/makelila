// verify-address: on-demand Google Maps Geocoding for an order's address.
// Compares the customer's parsed postal (from address_line) with Google's
// normalized postal. Writes the verdict to orders.address_match. On
// 'mismatch', also flips orders.status to 'flagged'.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { corsHeaders } from '../_shared/cors.ts';

type VerifyInput = { order_id: string };

type GoogleAddrComponent = {
  long_name: string;
  short_name: string;
  types: string[];
};

type GoogleResult = {
  formatted_address: string;
  address_components: GoogleAddrComponent[];
};

type GoogleResponse = {
  status: string;
  results: GoogleResult[];
  error_message?: string;
};

function normalizePostal(p: string | null | undefined, country: 'US' | 'CA' | string): string | null {
  if (!p) return null;
  const s = p.replace(/[\s-]/g, '').toUpperCase();
  if (country === 'US') {
    const m = s.match(/^(\d{5})\d{0,4}$/);
    return m ? m[1] : null;
  }
  if (country === 'CA') {
    return /^[A-Z]\d[A-Z]\d[A-Z]\d$/.test(s) ? s : null;
  }
  return s;
}

function parseCustomerPostal(addressLine: string | null, country: 'US' | 'CA' | string): string | null {
  if (!addressLine) return null;
  if (country === 'US') {
    const m = addressLine.match(/\b(\d{5})(-\d{4})?\b/);
    return m ? m[1] : null;
  }
  if (country === 'CA') {
    const m = addressLine.match(/\b([A-Za-z]\d[A-Za-z])[ -]?(\d[A-Za-z]\d)\b/);
    return m ? (m[1] + m[2]).toUpperCase() : null;
  }
  return null;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: corsHeaders });

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const apiKey      = Deno.env.get('GOOGLE_MAPS_API_KEY');
  if (!supabaseUrl || !serviceKey) {
    return j({ error: 'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY' }, 500);
  }
  if (!apiKey) {
    return j({ error: 'GOOGLE_MAPS_API_KEY not configured. Set it via supabase secrets set.' }, 500);
  }

  const { order_id } = (await req.json()) as VerifyInput;
  if (!order_id) return j({ error: 'order_id required' }, 400);

  const admin = createClient(supabaseUrl, serviceKey);

  const { data: order, error: oErr } = await admin
    .from('orders')
    .select('id, address_line, city, region_state, country, postal_code, status')
    .eq('id', order_id)
    .single();
  if (oErr || !order) return j({ error: `Order not found: ${oErr?.message}` }, 404);

  // Include postal_code in the geocoding query when we have it — Google's
  // match is much tighter with the ZIP than without.
  const query = [order.address_line, order.city, order.region_state, order.postal_code, order.country]
    .filter(Boolean).join(', ');
  if (!query) return j({ error: 'Order has no address to verify' }, 400);

  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(query)}&key=${apiKey}`;
  const gRes = await fetch(url);
  if (!gRes.ok) {
    const body = await gRes.text();
    return j({ error: `Google ${gRes.status}: ${body.slice(0, 400)}` }, 502);
  }
  const gJson = (await gRes.json()) as GoogleResponse;
  // Prefer the postal_code column (populated from Shopify shipping_address.zip);
  // fall back to regex on address_line for orders synced before that field
  // was captured.
  const customerPostal = normalizePostal(
    order.postal_code ?? parseCustomerPostal(order.address_line, order.country),
    order.country,
  );

  if (gJson.status !== 'OK' || gJson.results.length === 0) {
    await admin.from('orders').update({
      address_verified_at: new Date().toISOString(),
      address_match: 'unverifiable',
      address_google_formatted: null,
      address_google_postal: null,
      address_customer_postal: customerPostal,
    }).eq('id', order_id);
    return j({
      match: 'unverifiable',
      customer_postal: customerPostal,
      google_postal: null,
      google_formatted: null,
      google_status: gJson.status,
    });
  }

  const top = gJson.results[0];
  const postalComp = top.address_components.find(c => c.types.includes('postal_code'));
  const googlePostalRaw = postalComp?.short_name ?? null;
  const googlePostal = normalizePostal(googlePostalRaw, order.country);

  let match: 'match' | 'mismatch' | 'unverifiable';
  if (!googlePostal || !customerPostal) match = 'unverifiable';
  else if (googlePostal === customerPostal) match = 'match';
  else match = 'mismatch';

  const patch: Record<string, unknown> = {
    address_verified_at: new Date().toISOString(),
    address_match: match,
    address_google_formatted: top.formatted_address,
    address_google_postal: googlePostalRaw,
    address_customer_postal: customerPostal,
  };
  if (match === 'mismatch' && order.status !== 'flagged') {
    patch.status = 'flagged';
  }
  const { error: upErr } = await admin.from('orders').update(patch).eq('id', order_id);
  if (upErr) return j({ error: `DB update failed: ${upErr.message}` }, 500);

  return j({
    match,
    customer_postal: customerPostal,
    google_postal: googlePostalRaw,
    google_formatted: top.formatted_address,
  });
});

function j(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'content-type': 'application/json' },
  });
}
