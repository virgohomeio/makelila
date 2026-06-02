// verify-address: on-demand validation for an order's address via Google's
// Address Validation API (addressvalidation.googleapis.com/v1:validateAddress).
// Unlike the Geocoding API (which just resolves an address to coordinates and
// echoes a best-effort match), this returns a real validation verdict plus the
// USPS/postal-standardized address. We compare the validated postal with the
// customer's parsed postal and write the verdict to orders.address_match. On
// 'mismatch', also flips orders.status to 'flagged'.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { corsHeaders } from '../_shared/cors.ts';

type VerifyInput = { order_id: string };

// Subset of the Address Validation API response we care about.
// https://developers.google.com/maps/documentation/address-validation/reference/rest/v1/TopLevel/validateAddress
type AVAddressComponent = {
  componentName?: { text?: string };
  componentType?: string;
};
type AVResponse = {
  result?: {
    verdict?: {
      validationGranularity?: string;
      addressComplete?: boolean;
      hasUnconfirmedComponents?: boolean;
      hasInferredComponents?: boolean;
      hasReplacedComponents?: boolean;
    };
    address?: {
      formattedAddress?: string;
      postalAddress?: { postalCode?: string };
      addressComponents?: AVAddressComponent[];
    };
  };
  error?: { code?: number; message?: string; status?: string };
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

  const addressLines = [order.address_line].filter(Boolean) as string[];
  if (addressLines.length === 0 && !order.city && !order.postal_code) {
    return j({ error: 'Order has no address to verify' }, 400);
  }

  // Address Validation API takes a structured PostalAddress, not a free-text
  // query — pass each field separately for a tighter, validated result.
  const reqBody = {
    address: {
      regionCode: order.country,
      addressLines,
      locality: order.city || undefined,
      administrativeArea: order.region_state || undefined,
      postalCode: order.postal_code || undefined,
    },
  };

  const url = `https://addressvalidation.googleapis.com/v1:validateAddress?key=${apiKey}`;
  const gRes = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(reqBody),
  });
  if (!gRes.ok) {
    const body = await gRes.text();
    return j({ error: `Google Address Validation ${gRes.status}: ${body.slice(0, 400)}` }, 502);
  }
  const gJson = (await gRes.json()) as AVResponse;

  // Prefer the postal_code column (populated from Shopify shipping_address.zip);
  // fall back to regex on address_line for orders synced before that field
  // was captured.
  const customerPostal = normalizePostal(
    order.postal_code ?? parseCustomerPostal(order.address_line, order.country),
    order.country,
  );

  const result = gJson.result;
  // Validated postal: prefer the standardized postalAddress, fall back to the
  // postal_code address component.
  const validatedPostalRaw =
    result?.address?.postalAddress?.postalCode ??
    result?.address?.addressComponents?.find(c => c.componentType === 'postal_code')?.componentName?.text ??
    null;
  const validatedPostal = normalizePostal(validatedPostalRaw, order.country);
  const formatted = result?.address?.formattedAddress ?? null;
  const granularity = result?.verdict?.validationGranularity ?? 'GRANULARITY_UNSPECIFIED';
  // Granularities that mean "we couldn't pin this to a real place".
  const unusableGranularity = granularity === 'GRANULARITY_UNSPECIFIED' || granularity === 'OTHER';

  let match: 'match' | 'mismatch' | 'unverifiable';
  if (!result || unusableGranularity || !validatedPostal || !customerPostal) {
    match = 'unverifiable';
  } else if (validatedPostal === customerPostal) {
    match = 'match';
  } else {
    match = 'mismatch';
  }

  const patch: Record<string, unknown> = {
    address_verified_at: new Date().toISOString(),
    address_match: match,
    address_google_formatted: formatted,
    address_google_postal: validatedPostalRaw,
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
    google_postal: validatedPostalRaw,
    google_formatted: formatted,
  });
});

function j(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'content-type': 'application/json' },
  });
}
