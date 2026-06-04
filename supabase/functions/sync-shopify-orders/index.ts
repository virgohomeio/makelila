import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { corsHeaders } from '../_shared/cors.ts';

type ShopifyAddress = {
  address1?: string | null;
  city?: string | null;
  province_code?: string | null;
  country_code?: string | null;
  zip?: string | null;
  phone?: string | null;
};

// Shopify money_set: amounts in both the shop's base currency (shop_money)
// and what the customer was charged/shown (presentment_money). We use
// presentment everywhere so a CAD customer's summary shows CAD amounts.
type Money = { amount?: string | null; currency_code?: string | null };
type MoneySet = { shop_money?: Money | null; presentment_money?: Money | null };

type ShopifyLineItem = {
  sku?: string | null;
  title?: string | null;
  quantity?: number | null;
  price?: string | null;
  price_set?: MoneySet | null;
};

type ShopifyOrder = {
  name: string;                       // e.g. "#1113"
  email?: string | null;
  phone?: string | null;
  created_at?: string | null;
  currency?: string | null;           // shop/settlement currency, e.g. "USD"
  presentment_currency?: string | null; // what the customer was charged in, e.g. "CAD"
  total_price?: string | null;
  subtotal_price?: string | null;
  total_tax?: string | null;
  total_discounts?: string | null;
  total_price_set?: MoneySet | null;
  subtotal_price_set?: MoneySet | null;
  total_tax_set?: MoneySet | null;
  total_discounts_set?: MoneySet | null;
  discount_codes?: Array<{ code?: string | null }> | null;
  payment_gateway_names?: string[] | null;
  financial_status?: string | null;
  shipping_lines?: Array<{ price?: string | null; price_set?: MoneySet | null }>;
  shipping_address?: ShopifyAddress | null;
  customer?: { first_name?: string | null; last_name?: string | null; email?: string | null; phone?: string | null } | null;
  line_items?: ShopifyLineItem[];
};

type MappedOrder = {
  order_ref: string;
  status: 'pending' | 'flagged';
  customer_name: string;
  customer_email: string | null;
  customer_phone: string | null;
  quo_thread_url: null;
  address_line: string | null;
  city: string;
  region_state: string | null;
  country: 'US' | 'CA';
  address_verdict: 'house' | 'apt' | 'remote';
  freight_estimate_usd: number;
  freight_threshold_usd: number;
  total_usd: number;
  currency: string;
  postal_code: string | null;
  subtotal_usd: number | null;
  tax_usd: number | null;
  discount_total_usd: number | null;
  discount_codes: string[] | null;
  payment_methods: string[] | null;
  financial_status: string | null;
  line_items: Array<{ sku: string; name: string; qty: number; price_usd: number }>;
  placed_at: string | null;
};

function num(v: string | null | undefined): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Amount the customer was actually charged: prefer presentment_money, fall back
// to shop_money, then to the legacy flat string.
function presentmentNum(set: MoneySet | null | undefined, fallback?: string | null): number | null {
  return num(set?.presentment_money?.amount) ?? num(set?.shop_money?.amount) ?? num(fallback);
}

function verdictFor(
  addressLine: string | null | undefined,
  postalCode: string | null,
  remotePrefixes: string[],
): 'house' | 'apt' | 'remote' {
  // Postal-prefix match wins over the apt heuristic — remote zone is the
  // hardest-to-recover-from problem (carrier surcharge or refuses delivery).
  if (postalCode) {
    const p = postalCode.toUpperCase().replace(/\s/g, '');
    if (remotePrefixes.some(prefix => p.startsWith(prefix))) return 'remote';
  }
  const s = (addressLine ?? '').toLowerCase();
  if (/\bapt\b|\bapartment\b|\bsuite\b|\bunit\b|#\s*\d/.test(s)) return 'apt';
  return 'house';
}

function parseShippingFreight(order: ShopifyOrder): number {
  const line = order.shipping_lines?.[0];
  if (!line) return 0;
  return presentmentNum(line.price_set, line.price) ?? 0;
}

function mapOrder(
  o: ShopifyOrder,
  remotePrefixes: string[],
): MappedOrder | { error: string; order_ref: string } {
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
  const total = presentmentNum(o.total_price_set, o.total_price) ?? 0;
  const postal = addr.zip?.trim() || null;
  const verdict = verdictFor(addr.address1, postal, remotePrefixes);
  // Anything non-house (apt OR remote) gets auto-flagged for ops review.
  const initialStatus: 'pending' | 'flagged' = verdict === 'house' ? 'pending' : 'flagged';

  return {
    order_ref: o.name,
    status: initialStatus,
    customer_name: name,
    customer_email: email,
    customer_phone: phone,
    quo_thread_url: null,
    address_line: addr.address1 ?? null,
    city: addr.city,
    region_state: addr.province_code ?? null,
    country,
    address_verdict: verdict,
    freight_estimate_usd: freight,
    freight_threshold_usd: 200.00,
    total_usd: total,
    // Currency the customer was charged in (presentment); falls back to shop currency.
    currency: o.presentment_currency ?? o.currency ?? 'USD',
    postal_code: postal,
    subtotal_usd: presentmentNum(o.subtotal_price_set, o.subtotal_price),
    tax_usd: presentmentNum(o.total_tax_set, o.total_tax),
    discount_total_usd: presentmentNum(o.total_discounts_set, o.total_discounts),
    discount_codes: o.discount_codes?.map(d => d.code).filter((c): c is string => !!c) ?? null,
    payment_methods: o.payment_gateway_names ?? null,
    financial_status: o.financial_status ?? null,
    line_items: (o.line_items ?? []).map(li => ({
      sku: li.sku ?? 'UNKNOWN',
      name: li.title ?? 'Unknown item',
      qty: Number(li.quantity ?? 1) || 1,
      price_usd: presentmentNum(li.price_set, li.price) ?? 0,
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

  // 2. Load remote-postal prefixes once (used by verdictFor)
  const admin = createClient(supabaseUrl, serviceKey);
  const { data: prefixRows } = await admin
    .from('remote_postal_prefixes')
    .select('prefix');
  const remotePrefixes: string[] = (prefixRows ?? [])
    .map((r: { prefix: string }) => r.prefix.toUpperCase());

  // 3. Map + split mapped vs. skipped
  const mapped: MappedOrder[] = [];
  const skipped: Array<{ order_ref: string; error: string }> = [];
  for (const o of orders ?? []) {
    const result = mapOrder(o, remotePrefixes);
    if ('error' in result) skipped.push(result);
    else mapped.push(result);
  }

  // 4. Insert new orders (ignore dupes), then refresh Shopify-sourced fields
  //    (placed_at, freight_estimate_usd) on existing rows so historical syncs
  //    that happened before placed_at was mapped get corrected. We never
  //    overwrite internal fields like status/dispositioned_* here.

  // Pre-fetch existing orders so the refresh path can decide whether to also
  // pull contact/address updates (only safe when the operator hasn't yet
  // approved/held the order, i.e. status is pending or flagged).
  const orderRefs = mapped.map(m => m.order_ref);
  const { data: existingOrders } = await admin
    .from('orders')
    .select('order_ref, status, address_line, postal_code')
    .in('order_ref', orderRefs);
  const existingByRef = new Map(
    (existingOrders ?? []).map(o => [o.order_ref, o as { order_ref: string; status: string; address_line: string | null; postal_code: string | null }]),
  );

  let imported = 0;
  let refreshed = 0;
  let addressUpdated = 0;
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

    // Already existed — refresh Shopify source-of-truth fields. Always-safe
    // fields update unconditionally. Contact + address only update for orders
    // still in pending/flagged status (operator hasn't validated yet).
    const existing = existingByRef.get(m.order_ref);
    const operatorTouched = existing && !['pending', 'flagged'].includes(existing.status);

    const refreshPatch: Record<string, unknown> = {
      placed_at: m.placed_at,
      freight_estimate_usd: m.freight_estimate_usd,
      currency: m.currency,
      postal_code: m.postal_code,
      subtotal_usd: m.subtotal_usd,
      tax_usd: m.tax_usd,
      discount_total_usd: m.discount_total_usd,
      discount_codes: m.discount_codes,
      payment_methods: m.payment_methods,
      financial_status: m.financial_status,
    };

    let addressChanged = false;
    if (!operatorTouched) {
      refreshPatch.customer_email = m.customer_email;
      refreshPatch.customer_phone = m.customer_phone;
      refreshPatch.address_line   = m.address_line;
      refreshPatch.city           = m.city;
      refreshPatch.region_state   = m.region_state;
      refreshPatch.country        = m.country;
      refreshPatch.address_verdict = m.address_verdict;
      // Escalate pending → flagged if the new verdict isn't 'house'
      // (mirrors the new-order auto-flag rule; covers apt + remote)
      if (existing?.status === 'pending' && m.address_verdict !== 'house') {
        refreshPatch.status = 'flagged';
      }
      // If postal or street changed, the prior verification verdict is stale
      // — clear it so operator re-verifies
      if (
        (existing?.postal_code ?? null) !== (m.postal_code ?? null) ||
        (existing?.address_line ?? null) !== (m.address_line ?? null)
      ) {
        refreshPatch.address_verified_at = null;
        refreshPatch.address_match = null;
        refreshPatch.address_google_formatted = null;
        refreshPatch.address_google_postal = null;
        refreshPatch.address_customer_postal = null;
        addressChanged = true;
      }
    }

    const { error: upErr } = await admin
      .from('orders')
      .update(refreshPatch)
      .eq('order_ref', m.order_ref);
    if (upErr) {
      skipped.push({ order_ref: m.order_ref, error: `refresh: ${upErr.message}` });
      continue;
    }
    refreshed++;
    if (addressChanged) addressUpdated++;
  }

  return new Response(
    JSON.stringify({
      fetched: orders?.length ?? 0,
      imported,
      refreshed,
      addressUpdated,
      skipped: skipped.length,
      skippedDetails: skipped,
    }),
    { status: 200, headers: { ...corsHeaders, 'content-type': 'application/json' } },
  );
});
