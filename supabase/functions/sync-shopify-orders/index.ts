import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { corsHeaders } from '../_shared/cors.ts';
import { authenticate } from '../_shared/auth.ts';

type ShopifyAddress = {
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  province_code?: string | null;
  country_code?: string | null;
  zip?: string | null;
  phone?: string | null;
};

type Money = { amount?: string | null; currency_code?: string | null };
type MoneySet = { shop_money?: Money | null; presentment_money?: Money | null };

type ShopifyTaxLine = {
  title?: string | null;
  rate?: number | null;
  price_set?: MoneySet | null;
  price?: string | null;
};

type ShopifyLineItem = {
  sku?: string | null;
  title?: string | null;
  quantity?: number | null;
  price?: string | null;
  price_set?: MoneySet | null;
};

type ShopifyOrder = {
  name: string;
  id?: number | null;
  email?: string | null;
  phone?: string | null;
  created_at?: string | null;
  landing_site?: string | null;
  landing_site_ref?: string | null;
  referring_site?: string | null;
  currency?: string | null;
  presentment_currency?: string | null;
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
  tax_lines?: ShopifyTaxLine[] | null;
  shipping_lines?: Array<{
    title?: string | null;
    price?: string | null;
    price_set?: MoneySet | null;
  }> | null;
  shipping_address?: ShopifyAddress | null;
  customer?: {
    id?: number | null;
    first_name?: string | null;
    last_name?: string | null;
    email?: string | null;
    phone?: string | null;
  } | null;
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
  address_line2: string | null;
  city: string;
  region_state: string | null;
  country: 'US' | 'CA';
  address_verdict: 'house' | 'apt' | 'remote';
  area_type: 'urban' | 'suburban' | 'rural';
  area_type_source: string;
  freight_estimate_usd: number;
  freight_threshold_usd: number;
  freight_estimate_source: string;
  customer_paid_shipping_usd: number;
  shipping_line_title: string | null;
  total_usd: number;
  currency: string;
  postal_code: string | null;
  subtotal_usd: number | null;
  tax_usd: number | null;
  tax_lines: Array<{ title: string; rate: number; amount_usd: number }> | null;
  discount_total_usd: number | null;
  discount_codes: string[] | null;
  payment_methods: string[] | null;
  financial_status: string | null;
  line_items: Array<{ sku: string; name: string; qty: number; price_usd: number }>;
  placed_at: string | null;
  // Per-order acquisition source, Shopify-style: UTM on the landing URL wins,
  // else the referrer host (google → organic, facebook → social, …), else direct.
  attribution_source: string | null;
  attribution_medium: string | null;
  attribution_campaign: string | null;
};

function num(v: string | null | undefined): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function presentmentNum(set: MoneySet | null | undefined, fallback?: string | null): number | null {
  return num(set?.presentment_money?.amount) ?? num(set?.shop_money?.amount) ?? num(fallback);
}

function verdictFor(
  addressLine: string | null | undefined,
  postalCode: string | null,
  remotePrefixes: string[],
): 'house' | 'apt' | 'remote' {
  if (postalCode) {
    const p = postalCode.toUpperCase().replace(/\s/g, '');
    if (remotePrefixes.some(prefix => p.startsWith(prefix))) return 'remote';
  }
  const s = (addressLine ?? '').toLowerCase();
  if (/\bapt\b|\bapartment\b|\bsuite\b|\bunit\b|#\s*\d/.test(s)) return 'apt';
  return 'house';
}

function areaTypeFor(
  postalCode: string | null,
  country: 'US' | 'CA',
  remotePrefixes: string[],
): 'urban' | 'suburban' | 'rural' {
  if (postalCode) {
    const p = postalCode.toUpperCase().replace(/\s/g, '');
    if (remotePrefixes.some(prefix => p.startsWith(prefix))) return 'rural';
    if (country === 'CA' && /^[A-Z]0/.test(p)) return 'rural';
  }
  return 'suburban';
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

  const name = [o.customer?.first_name, o.customer?.last_name].filter(Boolean).join(' ')
    || (o.customer?.email ?? 'Unknown');
  const email = o.customer?.email ?? o.email ?? null;
  const phone = o.customer?.phone ?? o.phone ?? addr.phone ?? null;
  const shippingLine = o.shipping_lines?.[0] ?? null;
  const freight = shippingLine ? (presentmentNum(shippingLine.price_set, shippingLine.price) ?? 0) : 0;
  const total = presentmentNum(o.total_price_set, o.total_price) ?? 0;
  const postal = addr.zip?.trim() || null;
  const verdict = verdictFor(addr.address1, postal, remotePrefixes);
  const initialStatus: 'pending' | 'flagged' = verdict === 'house' ? 'pending' : 'flagged';

  const taxLines = (o.tax_lines ?? [])
    .map(tl => ({
      title: tl.title ?? 'Tax',
      rate: tl.rate ?? 0,
      amount_usd: presentmentNum(tl.price_set, tl.price) ?? 0,
    }))
    .filter(tl => tl.amount_usd > 0);

  return {
    order_ref: o.name,
    status: initialStatus,
    customer_name: name,
    customer_email: email,
    customer_phone: phone,
    quo_thread_url: null,
    address_line: addr.address1 ?? null,
    address_line2: addr.address2?.trim() || null,
    city: addr.city,
    region_state: addr.province_code ?? null,
    country,
    address_verdict: verdict,
    area_type: areaTypeFor(postal, country, remotePrefixes),
    area_type_source: 'auto',
    freight_estimate_usd: 0,
    freight_threshold_usd: 200.00,
    freight_estimate_source: 'manual',
    customer_paid_shipping_usd: freight,
    shipping_line_title: shippingLine?.title?.trim() || null,
    total_usd: total,
    currency: o.presentment_currency ?? o.currency ?? 'USD',
    postal_code: postal,
    subtotal_usd: presentmentNum(o.subtotal_price_set, o.subtotal_price),
    tax_usd: presentmentNum(o.total_tax_set, o.total_tax),
    tax_lines: taxLines.length > 0 ? taxLines : null,
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
    ...(() => {
      const a = deriveAttribution(o.landing_site ?? o.landing_site_ref ?? null, o.referring_site ?? null);
      return { attribution_source: a.source, attribution_medium: a.medium, attribution_campaign: a.campaign };
    })(),
  };
}

type Attribution = { source: string | null; medium: string | null; campaign: string | null };

/** UTM params off the landing URL. Returns null if there's no utm_source. */
function parseUtm(landingUrl: string | null | undefined): Attribution | null {
  if (!landingUrl) return null;
  try {
    const url = new URL(landingUrl);
    const source = url.searchParams.get('utm_source');
    if (!source) return null;
    return {
      source,
      medium: url.searchParams.get('utm_medium'),
      campaign: url.searchParams.get('utm_campaign'),
    };
  } catch {
    return null;
  }
}

/** Classify the referrer host the way Shopify's conversion summary does — a
 *  Google referral with no UTM is "google / organic search", Facebook is social,
 *  etc. Returns null for own-domain / unknown referrers (caller treats those as
 *  direct). */
function classifyReferrer(referring: string | null | undefined): Attribution | null {
  if (!referring) return null;
  let host: string;
  try { host = new URL(referring).hostname.toLowerCase(); } catch { return null; }
  if (!host) return null;
  const organic = (source: string): Attribution => ({ source, medium: 'organic', campaign: null });
  const social  = (source: string): Attribution => ({ source, medium: 'social', campaign: null });
  if (/(^|\.)google\./.test(host))                         return organic('google');
  if (/(^|\.)bing\./.test(host))                           return organic('bing');
  if (/duckduckgo|(^|\.)yahoo\.|ecosia|(^|\.)baidu\./.test(host)) return organic(host.replace(/^www\./, ''));
  if (/facebook\.|(^|\.)fb\.|lm\.facebook|l\.facebook/.test(host)) return social('facebook');
  if (/instagram\.|l\.instagram/.test(host))              return social('instagram');
  if (/youtube\.|youtu\.be/.test(host))                   return social('youtube');
  if (/tiktok\./.test(host))                              return social('tiktok');
  if (/t\.co|twitter\.|(^|\.)x\.com/.test(host))          return social('twitter');
  if (/pinterest\./.test(host))                           return social('pinterest');
  if (/linkedin\.|lnkd\.in/.test(host))                   return social('linkedin');
  if (/reddit\./.test(host))                              return social('reddit');
  return null;
}

/** Per-order acquisition: UTM wins, then referrer host, then direct. */
function deriveAttribution(landingUrl: string | null | undefined, referring: string | null | undefined): Attribution {
  return parseUtm(landingUrl)
    ?? classifyReferrer(referring)
    ?? { source: 'shopify_direct', medium: 'direct', campaign: null };
}

// Shopify's own conversion summary ("1st session from Google") lives on the
// GraphQL Order.customerJourneySummary.firstVisit — richer than the REST
// referring_site (which is usually empty). We prefer it when available.
type FirstVisit = {
  source?: string | null;
  sourceType?: string | null;
  utmParameters?: { source?: string | null; medium?: string | null; campaign?: string | null } | null;
};

/** Map Shopify's firstVisit into our source/medium. */
function journeyAttribution(fv: FirstVisit | null | undefined): Attribution | null {
  if (!fv) return null;
  const utm = fv.utmParameters;
  if (utm?.source) return { source: utm.source, medium: utm.medium ?? null, campaign: utm.campaign ?? null };
  const src = (fv.source ?? '').toLowerCase().trim();
  if (!src) return null;
  const type = (fv.sourceType ?? '').toLowerCase();
  const medium =
    type === 'search'   ? 'organic'  :
    type === 'social'   ? 'social'   :
    type === 'email'    ? 'email'    :
    type === 'direct'   ? 'direct'   :
    type === 'referral' ? 'referral' :
    (type || 'referral');
  return { source: src, medium, campaign: null };
}

/** Batched GraphQL lookup of each order's firstVisit source. Non-fatal: any
 *  failure just leaves the REST-derived attribution in place. Returns a map of
 *  order_ref → attribution for orders where Shopify has journey data. */
async function fetchJourneyAttribution(
  shop: string,
  headers: Record<string, string>,
  refs: string[],
  rawByRef: Map<string, ShopifyOrder>,
): Promise<Map<string, Attribution>> {
  const out = new Map<string, Attribution>();
  const withId = refs
    .map(ref => ({ ref, id: rawByRef.get(ref)?.id }))
    .filter((x): x is { ref: string; id: number } => typeof x.id === 'number');
  const FIELDS = 'customerJourneySummary { firstVisit { source sourceType utmParameters { source medium campaign } } }';
  for (let i = 0; i < withId.length; i += 40) {
    const batch = withId.slice(i, i + 40);
    const query = `{ ${batch.map((b, k) => `o${k}: order(id: "gid://shopify/Order/${b.id}") { ${FIELDS} }`).join(' ')} }`;
    try {
      const res = await fetch(`https://${shop}/admin/api/2024-10/graphql.json`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      });
      if (!res.ok) continue;
      const body = await res.json() as { data?: Record<string, { customerJourneySummary?: { firstVisit?: FirstVisit } } | null> };
      const data = body.data ?? {};
      batch.forEach((b, k) => {
        const attr = journeyAttribution(data[`o${k}`]?.customerJourneySummary?.firstVisit);
        if (attr) out.set(b.ref, attr);
      });
    } catch { /* non-fatal — keep REST-derived attribution */ }
  }
  return out;
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders });
  }

  const shop = Deno.env.get('SHOPIFY_SHOP_DOMAIN');
  const token = Deno.env.get('SHOPIFY_ADMIN_TOKEN');
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

  if (!shop || !token || !supabaseUrl || !serviceKey) {
    return new Response(
      JSON.stringify({ error: 'Missing env vars' }),
      { status: 500, headers: { ...corsHeaders, 'content-type': 'application/json' } },
    );
  }

  const admin = createClient(supabaseUrl, serviceKey);

  try { await authenticate(req, admin); }
  catch (e) { if (e instanceof Response) return e; throw e; }

  // Incremental mode: only fetch orders updated in the last 10 minutes.
  // pg_cron passes {"incremental": true}; manual sync omits it (full sync).
  let reqBody: Record<string, unknown> = {};
  try { reqBody = await req.json(); } catch { /* no body */ }
  const incremental = reqBody?.incremental === true;
  const updatedAtMin = incremental
    ? new Date(Date.now() - 10 * 60 * 1000).toISOString()
    : null;

  const shopHeaders = {
    'X-Shopify-Access-Token': token,
    'Accept': 'application/json',
  };
  const orders: ShopifyOrder[] = [];
  let nextUrl: string | null =
    `https://${shop}/admin/api/2024-10/orders.json?status=any&limit=250` +
    (updatedAtMin ? `&updated_at_min=${encodeURIComponent(updatedAtMin)}` : '');

  while (nextUrl) {
    const shopRes = await fetch(nextUrl, { headers: shopHeaders });
    if (!shopRes.ok) {
      const errBody = await shopRes.text();
      return new Response(
        JSON.stringify({ error: `Shopify ${shopRes.status}: ${errBody.slice(0, 400)}` }),
        { status: 502, headers: { ...corsHeaders, 'content-type': 'application/json' } },
      );
    }
    const { orders: page } = await shopRes.json() as { orders: ShopifyOrder[] };
    orders.push(...(page ?? []));
    const link = shopRes.headers.get('Link') ?? '';
    const nextMatch = link.match(/<([^>]+)>;\s*rel="next"/);
    nextUrl = nextMatch ? nextMatch[1] : null;
  }

  const { data: prefixRows } = await admin
    .from('remote_postal_prefixes')
    .select('prefix');
  const remotePrefixes: string[] = (prefixRows ?? [])
    .map((r: { prefix: string }) => r.prefix.toUpperCase());

  const mapped: MappedOrder[] = [];
  const skipped: Array<{ order_ref: string; error: string }> = [];
  const rawByRef = new Map<string, ShopifyOrder>();
  for (const o of orders ?? []) {
    const result = mapOrder(o, remotePrefixes);
    if ('error' in result) skipped.push(result);
    else { mapped.push(result); rawByRef.set(o.name, o); }
  }

  // Prefer Shopify's own customer-journey source (matches the order's
  // "conversion summary" in the admin, e.g. "1st session from Google") over the
  // REST landing/referrer heuristic. Non-fatal — falls back if GraphQL is
  // unavailable or the scope is missing.
  try {
    const journey = await fetchJourneyAttribution(shop, shopHeaders, mapped.map(m => m.order_ref), rawByRef);
    for (const m of mapped) {
      const j = journey.get(m.order_ref);
      if (j?.source) {
        m.attribution_source = j.source;
        m.attribution_medium = j.medium;
        m.attribution_campaign = j.campaign;
      }
    }
  } catch { /* keep REST-derived attribution */ }

  const orderRefs = mapped.map(m => m.order_ref);
  const { data: existingOrders } = await admin
    .from('orders')
    .select('order_ref, status, address_line, postal_code, area_type_source')
    .in('order_ref', orderRefs);
  const existingByRef = new Map(
    (existingOrders ?? []).map(o => [o.order_ref, o as {
      order_ref: string; status: string;
      address_line: string | null; postal_code: string | null; area_type_source: string | null;
    }]),
  );

  // Batch-fetch existing customers to avoid N+1 on upsert
  const emailsToCheck = [...new Set(
    mapped.map(m => m.customer_email?.toLowerCase()).filter((e): e is string => !!e),
  )];
  type CustRow = { id: string; email: string; shopify_id: string | null; first_name: string | null; last_name: string | null; phone: string | null };
  const { data: existingCustomers } = await admin
    .from('customers')
    .select('id, email, shopify_id, first_name, last_name, phone')
    .in('email', emailsToCheck);
  const customerByEmail = new Map<string, CustRow>(
    (existingCustomers ?? []).map(c => [(c as CustRow).email?.toLowerCase(), c as CustRow]),
  );

  let imported = 0;
  let refreshed = 0;
  let addressUpdated = 0;
  let customersUpserted = 0;

  for (const m of mapped) {
    const { data, error } = await admin
      .from('orders')
      .upsert(m, { onConflict: 'order_ref', ignoreDuplicates: true })
      .select('id');

    if (error) {
      skipped.push({ order_ref: m.order_ref, error: `db: ${error.message}` });
      continue;
    }

    const isNew = data && data.length > 0;
    if (isNew) {
      imported++;
      const raw = rawByRef.get(m.order_ref);
      if (m.attribution_source && m.customer_email) {
        const email = m.customer_email.toLowerCase();
        const at = raw?.created_at ?? new Date().toISOString();
        // First touch — insert-only (never overwrite the original acquisition).
        await admin
          .from('customers')
          .update({
            first_touch_source: m.attribution_source,
            first_touch_medium: m.attribution_medium,
            first_touch_campaign_id: m.attribution_campaign,
            first_touch_at: at,
          })
          .eq('email', email)
          .is('first_touch_source', null);
        // Last touch — reflects the most recent order's landing, so the journey
        // shows the channel that actually drove the latest purchase.
        await admin
          .from('customers')
          .update({
            last_touch_source: m.attribution_source,
            last_touch_medium: m.attribution_medium,
            last_touch_campaign_id: m.attribution_campaign,
            last_touch_at: at,
          })
          .eq('email', email);
      }
    } else {
      // Refresh Shopify source-of-truth fields on existing order
      const existing = existingByRef.get(m.order_ref);
      const operatorTouched = existing && !['pending', 'flagged'].includes(existing.status);

      const refreshPatch: Record<string, unknown> = {
        placed_at: m.placed_at,
        customer_paid_shipping_usd: m.customer_paid_shipping_usd,
        shipping_line_title: m.shipping_line_title,
        currency: m.currency,
        postal_code: m.postal_code,
        subtotal_usd: m.subtotal_usd,
        tax_usd: m.tax_usd,
        tax_lines: m.tax_lines,
        discount_total_usd: m.discount_total_usd,
        discount_codes: m.discount_codes,
        payment_methods: m.payment_methods,
        financial_status: m.financial_status,
        line_items: m.line_items,
        // Shopify-derived source of truth — safe to refresh; backfills existing
        // orders (that predate this column) on the next full sync.
        attribution_source: m.attribution_source,
        attribution_medium: m.attribution_medium,
        attribution_campaign: m.attribution_campaign,
      };

      let addressChanged = false;
      if (!operatorTouched) {
        refreshPatch.customer_email = m.customer_email;
        refreshPatch.customer_phone = m.customer_phone;
        refreshPatch.address_line   = m.address_line;
        refreshPatch.address_line2  = m.address_line2;
        refreshPatch.city           = m.city;
        refreshPatch.region_state   = m.region_state;
        refreshPatch.country        = m.country;
        refreshPatch.address_verdict = m.address_verdict;
        if ((existing?.area_type_source ?? 'auto') === 'auto') {
          refreshPatch.area_type = m.area_type;
          refreshPatch.area_type_source = 'auto';
        }
        if (existing?.status === 'pending' && m.address_verdict !== 'house') {
          refreshPatch.status = 'flagged';
        }
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

    // Customer upsert: sync phone + address always; fill name only if blank.
    // Never touches operator-curated fields (notes, journey, follow-up statuses).
    if (!m.customer_email) continue;
    const emailKey = m.customer_email.toLowerCase();
    const raw = rawByRef.get(m.order_ref);
    const shopifyCustomerId = raw?.customer?.id ? String(raw.customer.id) : null;
    const addr = raw?.shipping_address ?? null;

    const existingCust = customerByEmail.get(emailKey);
    if (existingCust) {
      const patch: Record<string, unknown> = {
        phone:        m.customer_phone,
        address_line: addr?.address1 ?? null,
        city:         addr?.city ?? null,
        region:       addr?.province_code ?? null,
        postal_code:  addr?.zip?.trim() || null,
        country:      addr?.country_code ?? null,
        last_synced_at: new Date().toISOString(),
      };
      if (shopifyCustomerId && !existingCust.shopify_id) patch.shopify_id = shopifyCustomerId;
      if (!existingCust.first_name && raw?.customer?.first_name) patch.first_name = raw.customer.first_name;
      if (!existingCust.last_name && raw?.customer?.last_name) patch.last_name = raw.customer.last_name;
      const { error: custErr } = await admin.from('customers').update(patch).eq('id', existingCust.id);
      if (!custErr) customersUpserted++;
    } else {
      const { error: custErr } = await admin.from('customers').insert({
        email:        emailKey,
        shopify_id:   shopifyCustomerId,
        first_name:   raw?.customer?.first_name ?? null,
        last_name:    raw?.customer?.last_name ?? null,
        phone:        m.customer_phone,
        address_line: addr?.address1 ?? null,
        city:         addr?.city ?? null,
        region:       addr?.province_code ?? null,
        postal_code:  addr?.zip?.trim() || null,
        country:      addr?.country_code ?? null,
        last_synced_at: new Date().toISOString(),
      });
      if (!custErr) {
        customersUpserted++;
        customerByEmail.set(emailKey, {
          id: '', email: emailKey, shopify_id: shopifyCustomerId,
          first_name: raw?.customer?.first_name ?? null,
          last_name: raw?.customer?.last_name ?? null,
          phone: m.customer_phone,
        });
      }
    }
  }

  return new Response(
    JSON.stringify({
      mode: incremental ? 'incremental' : 'full',
      fetched: orders?.length ?? 0,
      imported,
      refreshed,
      addressUpdated,
      customersUpserted,
      skipped: skipped.length,
      skippedDetails: skipped,
    }),
    { status: 200, headers: { ...corsHeaders, 'content-type': 'application/json' } },
  );
});
