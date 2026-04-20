import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { corsHeaders } from '../_shared/cors.ts';

type ShopifyAddress = {
  address1?: string | null;
  city?: string | null;
  province_code?: string | null;
  country_code?: string | null;
  phone?: string | null;
};

type ShopifyLineItem = {
  sku?: string | null;
  title?: string | null;
  quantity?: number | null;
  price?: string | null;
};

type ShopifyOrder = {
  name: string;                       // e.g. "#1113"
  email?: string | null;
  phone?: string | null;
  created_at?: string | null;
  total_price?: string | null;
  shipping_lines?: Array<{ price?: string | null }>;
  shipping_address?: ShopifyAddress | null;
  customer?: { first_name?: string | null; last_name?: string | null; email?: string | null; phone?: string | null } | null;
  line_items?: ShopifyLineItem[];
};

type MappedOrder = {
  order_ref: string;
  status: 'pending';
  customer_name: string;
  customer_email: string | null;
  customer_phone: string | null;
  quo_thread_url: null;
  address_line: string | null;
  city: string;
  region_state: string | null;
  country: 'US' | 'CA';
  address_verdict: 'house' | 'apt';
  freight_estimate_usd: number;
  freight_threshold_usd: number;
  total_usd: number;
  line_items: Array<{ sku: string; name: string; qty: number; price_usd: number }>;
  placed_at: string | null;
};

function verdictFor(addressLine: string | null | undefined): 'house' | 'apt' {
  const s = (addressLine ?? '').toLowerCase();
  if (/\bapt\b|\bapartment\b|\bsuite\b|\bunit\b|#\s*\d/.test(s)) return 'apt';
  return 'house';
}

function parseShippingFreight(order: ShopifyOrder): number {
  const line = order.shipping_lines?.[0];
  if (!line) return 0;
  // Newer API: price_set.shop_money.amount (multi-currency aware)
  const priceSetAmount = (line as { price_set?: { shop_money?: { amount?: string | null } } })
    .price_set?.shop_money?.amount;
  if (priceSetAmount) {
    const n = Number(priceSetAmount);
    if (Number.isFinite(n)) return n;
  }
  // Older API: flat price string
  if (line.price) {
    const n = Number(line.price);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

function mapOrder(o: ShopifyOrder): MappedOrder | { error: string; order_ref: string } {
  const addr = o.shipping_address ?? null;
  const country = addr?.country_code;
  if (country !== 'US' && country !== 'CA') {
    return { error: `unsupported country: ${country ?? 'null'}`, order_ref: o.name };
  }
  if (!addr?.city) {
    return { error: 'missing city', order_ref: o.name };
  }

  const name = [o.customer?.first_name, o.customer?.last_name].filter(Boolean).join(' ') || (o.customer?.email ?? 'Unknown');
  const email = o.customer?.email ?? o.email ?? null;
  const phone = o.customer?.phone ?? o.phone ?? addr.phone ?? null;
  const freight = parseShippingFreight(o);
  const total = Number(o.total_price ?? '0') || 0;

  return {
    order_ref: o.name,
    status: 'pending',
    customer_name: name,
    customer_email: email,
    customer_phone: phone,
    quo_thread_url: null,
    address_line: addr.address1 ?? null,
    city: addr.city,
    region_state: addr.province_code ?? null,
    country,
    address_verdict: verdictFor(addr.address1),
    freight_estimate_usd: freight,
    freight_threshold_usd: 200.00,
    total_usd: total,
    line_items: (o.line_items ?? []).map(li => ({
      sku: li.sku ?? 'UNKNOWN',
      name: li.title ?? 'Unknown item',
      qty: Number(li.quantity ?? 1) || 1,
      price_usd: Number(li.price ?? '0') || 0,
    })),
    placed_at: o.created_at ?? null,
  };
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders });
  }

  const shop = Deno.env.get('SHOPIFY_SHOP_DOMAIN');    // e.g. "virgohome.myshopify.com"
  const token = Deno.env.get('SHOPIFY_ADMIN_TOKEN');
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

  if (!shop || !token || !supabaseUrl || !serviceKey) {
    return new Response(
      JSON.stringify({ error: 'Missing SHOPIFY_SHOP_DOMAIN / SHOPIFY_ADMIN_TOKEN / SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY' }),
      { status: 500, headers: { ...corsHeaders, 'content-type': 'application/json' } },
    );
  }

  // 1. Fetch Shopify orders
  const shopUrl = `https://${shop}/admin/api/2024-10/orders.json?status=open&fulfillment_status=unfulfilled&limit=50`;
  const shopRes = await fetch(shopUrl, {
    headers: {
      'X-Shopify-Access-Token': token,
      'Accept': 'application/json',
    },
  });
  if (!shopRes.ok) {
    const body = await shopRes.text();
    return new Response(
      JSON.stringify({ error: `Shopify ${shopRes.status}: ${body.slice(0, 400)}` }),
      { status: 502, headers: { ...corsHeaders, 'content-type': 'application/json' } },
    );
  }
  const { orders } = await shopRes.json() as { orders: ShopifyOrder[] };

  // 2. Map + split mapped vs. skipped
  const mapped: MappedOrder[] = [];
  const skipped: Array<{ order_ref: string; error: string }> = [];
  for (const o of orders ?? []) {
    const result = mapOrder(o);
    if ('error' in result) skipped.push(result);
    else mapped.push(result);
  }

  // 3. Insert new orders (ignore dupes), then refresh Shopify-sourced fields
  //    (placed_at, freight_estimate_usd) on existing rows so historical syncs
  //    that happened before placed_at was mapped get corrected. We never
  //    overwrite internal fields like status/dispositioned_* here.
  const admin = createClient(supabaseUrl, serviceKey);
  let imported = 0;
  let refreshed = 0;
  for (const m of mapped) {
    const { data, error } = await admin
      .from('orders')
      .upsert(m, { onConflict: 'order_ref', ignoreDuplicates: true })
      .select('id');
    if (error) {
      skipped.push({ order_ref: m.order_ref, error: `db: ${error.message}` });
      continue;
    }
    if (data && data.length > 0) {
      imported++;
      continue;
    }
    // Already existed — refresh Shopify source-of-truth fields
    const { error: upErr } = await admin
      .from('orders')
      .update({
        placed_at: m.placed_at,
        freight_estimate_usd: m.freight_estimate_usd,
      })
      .eq('order_ref', m.order_ref);
    if (upErr) {
      skipped.push({ order_ref: m.order_ref, error: `refresh: ${upErr.message}` });
      continue;
    }
    refreshed++;
  }

  return new Response(
    JSON.stringify({
      fetched: orders?.length ?? 0,
      imported,
      refreshed,
      skipped: skipped.length,
      skippedDetails: skipped,
    }),
    { status: 200, headers: { ...corsHeaders, 'content-type': 'application/json' } },
  );
});
