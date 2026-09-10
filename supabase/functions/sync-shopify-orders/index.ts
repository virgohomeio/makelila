import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { corsHeaders } from '../_shared/cors.ts';
import { authenticate } from '../_shared/auth.ts';
import { guessDwellingFromText, areaTypeFromPostal, type Dwelling } from '../_shared/addressClassify.ts';

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
  address_verdict: Dwelling;
  address_verdict_source: 'sync-guess';
  area_type: 'urban' | 'suburban' | 'rural' | null;
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
  attribution_referrer: string | null;
  attribution_last_source: string | null;
  attribution_last_medium: string | null;
  attribution_last_referrer: string | null;
};

function num(v: string | null | undefined): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function presentmentNum(set: MoneySet | null | undefined, fallback?: string | null): number | null {
  return num(set?.presentment_money?.amount) ?? num(set?.shop_money?.amount) ?? num(fallback);
}

/** The dwelling type an order is BORN with: a text match on what the customer
 *  typed, checked against nothing. Always paired with source 'sync-guess' so
 *  the card can show it as the starting point it is; verify-address replaces it
 *  with Google's answer and flips the source to 'google'.
 *
 *  The rules live in _shared/addressClassify.ts, which reads BOTH address
 *  lines — the old inline version looked only at address1, and Shopify puts the
 *  unit number in address2, which is why 14 live orders with a unit on file
 *  (a tower unit in Bay Harbor Islands, #21 on Bute St in downtown Vancouver,
 *  'Suite 102' in Chesapeake) all read 'house'. */
function verdictFor(
  addressLine: string | null | undefined,
  addressLine2: string | null | undefined,
  postalCode: string | null,
  remotePrefixes: string[],
): Dwelling {
  return guessDwellingFromText(addressLine, addressLine2, postalCode, remotePrefixes);
}

/** The area type a postal code alone can establish, and nothing more.
 *
 *  This used to end in `return 'suburban'`, so every non-rural order was born
 *  claiming a classification nobody had made — ~200 rows reading 'Suburban'
 *  with an 'auto' provenance the UI rendered as "auto-guess", visually
 *  indistinguishable from the real per-address classification verify-address
 *  produces. Urban and suburban cannot be told apart from a postal code, so
 *  now the honest answer, null, is what gets written. */
function areaTypeFor(
  postalCode: string | null,
  country: 'US' | 'CA',
  remotePrefixes: string[],
): 'urban' | 'suburban' | 'rural' | null {
  return areaTypeFromPostal(postalCode, country, remotePrefixes);
}

/** Why an order Shopify handed us never became a row in `orders`.
 *
 *  These are not all failures. `no_shipping_address` is the normal shape of a
 *  no-ship product — the $1 "LILA Mini Reservation", a subscription buyout —
 *  and `orders.country` is NOT NULL with a CHECK of ('US','CA'), so there is
 *  nowhere to put one. What was broken is that the sync reported every one of
 *  these as an anonymous "skipped" tally, so 27 reservations and a $1,418
 *  buyout looked identical to a write failure. Each skip now carries enough to
 *  identify the order on sight. */
type SkipReason =
  | 'no_shipping_address'
  | 'international'
  | 'missing_city'
  | 'db_error';

type Skip = {
  order_ref: string;
  reason: SkipReason;
  /** Free text for db_error; empty for the classification-only reasons. */
  detail: string;
  placed_at: string | null;
  total: string | null;
  currency: string | null;
  customer: string | null;
  items: string[];
};

function skipRecord(o: ShopifyOrder, reason: SkipReason, detail = ''): Skip {
  return {
    order_ref: o.name,
    reason,
    detail,
    placed_at: o.created_at ?? null,
    total: o.total_price ?? null,
    currency: o.presentment_currency ?? o.currency ?? null,
    customer: [o.customer?.first_name, o.customer?.last_name].filter(Boolean).join(' ')
      || o.customer?.email || o.email || null,
    items: (o.line_items ?? []).map(li => li.title ?? 'Unknown item'),
  };
}

function mapOrder(
  o: ShopifyOrder,
  remotePrefixes: string[],
): MappedOrder | Skip {
  const addr = o.shipping_address ?? null;
  const country = addr?.country_code;
  if (!addr) {
    return skipRecord(o, 'no_shipping_address');
  }
  if (country !== 'US' && country !== 'CA') {
    return skipRecord(o, 'international', country ?? 'no country');
  }
  if (!addr.city) {
    return skipRecord(o, 'missing_city');
  }

  const name = [o.customer?.first_name, o.customer?.last_name].filter(Boolean).join(' ')
    || (o.customer?.email ?? 'Unknown');
  const email = o.customer?.email ?? o.email ?? null;
  const phone = o.customer?.phone ?? o.phone ?? addr.phone ?? null;
  const shippingLine = o.shipping_lines?.[0] ?? null;
  const freight = shippingLine ? (presentmentNum(shippingLine.price_set, shippingLine.price) ?? 0) : 0;
  const total = presentmentNum(o.total_price_set, o.total_price) ?? 0;
  const postal = addr.zip?.trim() || null;
  const verdict = verdictFor(addr.address1, addr.address2, postal, remotePrefixes);
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
    address_verdict_source: 'sync-guess' as const,
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
      return {
        attribution_source: a.source,
        attribution_medium: a.medium,
        attribution_campaign: a.campaign,
        attribution_referrer: o.referring_site ?? null,
        // Last-visit fields only come from the GraphQL journey; null on REST.
        attribution_last_source: null,
        attribution_last_medium: null,
        attribution_last_referrer: null,
      };
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

function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; }
}

/** Classify the referrer host the way Shopify's conversion summary does — a
 *  Google referral with no UTM is "google / organic search", Facebook is social,
 *  Linktree is our link-in-bio, etc. Returns null only when there's no host at
 *  all (caller then decides direct vs. generic referral). */
function classifyReferrer(referring: string | null | undefined): Attribution | null {
  const host = hostOf(referring);
  if (!host) return null;
  const organic = (source: string): Attribution => ({ source, medium: 'organic', campaign: null });
  const social  = (source: string): Attribution => ({ source, medium: 'social', campaign: null });
  const referral = (source: string): Attribution => ({ source, medium: 'referral', campaign: null });
  if (/(^|\.)google\./.test(host))                         return organic('google');
  if (/(^|\.)bing\./.test(host))                           return organic('bing');
  if (/duckduckgo|(^|\.)yahoo\.|ecosia|(^|\.)baidu\./.test(host)) return organic(host);
  if (/facebook\.|(^|\.)fb\.|lm\.facebook|l\.facebook/.test(host)) return social('facebook');
  if (/instagram\.|l\.instagram/.test(host))              return social('instagram');
  if (/youtube\.|youtu\.be/.test(host))                   return social('youtube');
  if (/tiktok\./.test(host))                              return social('tiktok');
  if (/t\.co|twitter\.|(^|\.)x\.com/.test(host))          return social('twitter');
  if (/pinterest\./.test(host))                           return social('pinterest');
  if (/linkedin\.|lnkd\.in/.test(host))                   return social('linkedin');
  if (/reddit\./.test(host))                              return social('reddit');
  if (/linktr\.ee|linktree/.test(host))                   return referral('linktree');
  if (/beacons\.ai|bio\.link|milkshake|carrd\./.test(host)) return referral(host);
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
  referrerUrl?: string | null;
  utmParameters?: { source?: string | null; medium?: string | null; campaign?: string | null } | null;
};

/** Map Shopify's firstVisit into our source/medium. Precedence: UTM tags →
 *  the specific referrer host (linktree, instagram, a blog…) → Shopify's own
 *  source/sourceType label. */
function journeyAttribution(fv: FirstVisit | null | undefined): Attribution | null {
  if (!fv) return null;
  const utm = fv.utmParameters;
  if (utm?.source) return { source: utm.source, medium: utm.medium ?? null, campaign: utm.campaign ?? null };

  // Prefer the actual referring site so a referral resolves to its real channel
  // (Instagram, Linktree, someblog.com) rather than a bare "referral".
  const known = classifyReferrer(fv.referrerUrl);
  if (known) return known;
  const host = hostOf(fv.referrerUrl);
  if (host) return { source: host, medium: 'referral', campaign: null };

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

/** Run `task` over `items` with at most `limit` in flight.
 *
 *  A full sync is ~250 orders, and every one of them used to be three
 *  round-trips awaited one after another: the order write, then the customer
 *  write, then the touch updates. That is pure latency — it put the manual
 *  sync at ~70s wall clock with the Sales button disabled for all of it, and
 *  it grows with every order the store ever takes. Nothing in the per-order
 *  work depends on another order, so it does not have to be a queue. */
async function mapPool<T, R>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await task(items[i]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return out;
}

// Postgrest round-trips in flight at once. High enough to erase the latency,
// low enough not to exhaust the pooler on a store with thousands of orders.
const DB_CONCURRENCY = 10;

/** Batched GraphQL lookup of each order's firstVisit source. Non-fatal: any
 *  failure just leaves the REST-derived attribution in place. Returns a map of
 *  order_ref → attribution for orders where Shopify has journey data. */
type VisitAttr = { attr: Attribution; referrer: string | null };
type JourneyResult = { first: VisitAttr | null; last: VisitAttr | null };

function visitAttr(v: FirstVisit | null | undefined): VisitAttr | null {
  const attr = journeyAttribution(v);
  return attr ? { attr, referrer: v?.referrerUrl ?? null } : null;
}

async function fetchJourneyAttribution(
  shop: string,
  headers: Record<string, string>,
  refs: string[],
  rawByRef: Map<string, ShopifyOrder>,
): Promise<{ journey: Map<string, JourneyResult>; failedBatches: number }> {
  const out = new Map<string, JourneyResult>();
  const withId = refs
    .map(ref => ({ ref, id: rawByRef.get(ref)?.id }))
    .filter((x): x is { ref: string; id: number } => typeof x.id === 'number');
  const VISIT = 'source sourceType referrerUrl utmParameters { source medium campaign }';
  const FIELDS = `customerJourneySummary { firstVisit { ${VISIT} } lastVisit { ${VISIT} } }`;
  const batches: Array<Array<{ ref: string; id: number }>> = [];
  for (let i = 0; i < withId.length; i += 40) batches.push(withId.slice(i, i + 40));

  // 3 at a time: enough to hide the latency, well inside Shopify's GraphQL
  // leaky bucket for a query this cheap.
  let failed = 0;
  await mapPool(batches, 3, async batch => {
    const query = `{ ${batch.map((b, k) => `o${k}: order(id: "gid://shopify/Order/${b.id}") { ${FIELDS} }`).join(' ')} }`;
    try {
      const res = await fetch(`https://${shop}/admin/api/2024-10/graphql.json`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      });
      if (!res.ok) { failed++; return; }
      const body = await res.json() as { data?: Record<string, { customerJourneySummary?: { firstVisit?: FirstVisit; lastVisit?: FirstVisit } } | null> };
      const data = body.data ?? {};
      batch.forEach((b, k) => {
        const cjs = data[`o${k}`]?.customerJourneySummary;
        out.set(b.ref, { first: visitAttr(cjs?.firstVisit), last: visitAttr(cjs?.lastVisit) });
      });
    } catch { failed++; }
  });
  // Losing the journey lookup is survivable — the REST landing/referrer
  // heuristic still stands — but it silently downgrades every attribution in
  // the batch, so say so rather than letting the fallback pass for success.
  return { journey: out, failedBatches: failed };
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
  const skipped: Skip[] = [];
  const rawByRef = new Map<string, ShopifyOrder>();
  for (const o of orders ?? []) {
    const result = mapOrder(o, remotePrefixes);
    if ('reason' in result) skipped.push(result);
    else { mapped.push(result); rawByRef.set(o.name, o); }
  }

  // Prefer Shopify's own customer-journey source (matches the order's
  // "conversion summary" in the admin, e.g. "1st session from Google") over the
  // REST landing/referrer heuristic. Non-fatal — falls back if GraphQL is
  // unavailable or the scope is missing.
  let journeyBatchesFailed = 0;
  try {
    const { journey, failedBatches } =
      await fetchJourneyAttribution(shop, shopHeaders, mapped.map(m => m.order_ref), rawByRef);
    journeyBatchesFailed = failedBatches;
    for (const m of mapped) {
      const j = journey.get(m.order_ref);
      if (j?.first?.attr.source) {
        m.attribution_source = j.first.attr.source;
        m.attribution_medium = j.first.attr.medium;
        m.attribution_campaign = j.first.attr.campaign;
        if (j.first.referrer) m.attribution_referrer = j.first.referrer;
      }
      if (j?.last?.attr.source) {
        m.attribution_last_source = j.last.attr.source;
        m.attribution_last_medium = j.last.attr.medium;
        m.attribution_last_referrer = j.last.referrer;
      }
    }
  } catch { /* keep REST-derived attribution */ }

  const orderRefs = mapped.map(m => m.order_ref);
  const { data: existingOrders } = await admin
    .from('orders')
    // address_line2 and address_verdict_source are both load-bearing below:
    // without line2 the "did the address change?" test can never see a unit
    // number being added, and without the verdict source the refresh would
    // overwrite a Google-confirmed dwelling type with the sync's own guess on
    // every run.
    .select('order_ref, status, address_line, address_line2, postal_code, area_type_source, address_verdict_source')
    .in('order_ref', orderRefs);
  const existingByRef = new Map(
    (existingOrders ?? []).map(o => [o.order_ref, o as {
      order_ref: string; status: string;
      address_line: string | null; address_line2: string | null;
      postal_code: string | null; area_type_source: string | null;
      address_verdict_source: string | null;
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

  // ── Phase 1: orders ────────────────────────────────────────────────────────
  // We already know from `existingByRef` which refs are new, so the inserts go
  // in one statement instead of one per order. ignoreDuplicates keeps it safe
  // against an order that landed between the select and this write; the
  // returned refs are the ones that actually inserted.
  const fresh = mapped.filter(m => !existingByRef.has(m.order_ref));
  const insertedRefs = new Set<string>();
  const failedRefs = new Set<string>();
  if (fresh.length > 0) {
    const { data, error } = await admin
      .from('orders')
      .upsert(fresh, { onConflict: 'order_ref', ignoreDuplicates: true })
      .select('order_ref');
    if (error) {
      // One bad row fails the whole statement, so fall back to per-order
      // writes: a single malformed order must not cost us the other 200.
      await mapPool(fresh, DB_CONCURRENCY, async m => {
        const { data: one, error: oneErr } = await admin
          .from('orders')
          .upsert(m, { onConflict: 'order_ref', ignoreDuplicates: true })
          .select('order_ref');
        if (oneErr) {
          skipped.push(skipRecord(rawByRef.get(m.order_ref)!, 'db_error', oneErr.message));
          failedRefs.add(m.order_ref);
        } else if (one && one.length > 0) {
          insertedRefs.add(m.order_ref);
        }
      });
    } else {
      for (const row of data ?? []) insertedRefs.add((row as { order_ref: string }).order_ref);
    }
  }
  imported = insertedRefs.size;

  // Anything the insert refused has no row to refresh — updating it would match
  // nothing and still count itself a success, on top of the skip it already
  // reported.
  const stale = mapped.filter(m => !insertedRefs.has(m.order_ref) && !failedRefs.has(m.order_ref));
  await mapPool(stale, DB_CONCURRENCY, async m => {
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
      attribution_referrer: m.attribution_referrer,
      attribution_last_source: m.attribution_last_source,
      attribution_last_medium: m.attribution_last_medium,
      attribution_last_referrer: m.attribution_last_referrer,
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
      // A re-sync must never demote a checked fact back to a guess. Only
      // refresh the dwelling verdict while it is still the sync's own
      // 'sync-guess'; a 'google' verdict came from the Address Validation API
      // and a 'manual' one from an operator, and this heuristic knows less
      // than either. (The address-changed branch below is what legitimately
      // clears a stale 'google' verdict.)
      if ((existing?.address_verdict_source ?? 'sync-guess') === 'sync-guess') {
        refreshPatch.address_verdict = m.address_verdict;
        refreshPatch.address_verdict_source = 'sync-guess';
      }
      if ((existing?.area_type_source ?? 'auto') === 'auto') {
        // Only when the postal rule actually fired. m.area_type is null for
        // everything it can't establish, and writing that null would blank a
        // value an earlier verify had legitimately set.
        if (m.area_type) {
          refreshPatch.area_type = m.area_type;
          refreshPatch.area_type_source = 'auto';
        }
      }
      if (existing?.status === 'pending' && m.address_verdict !== 'house') {
        refreshPatch.status = 'flagged';
      }
      if (
        (existing?.postal_code ?? null) !== (m.postal_code ?? null) ||
        (existing?.address_line ?? null) !== (m.address_line ?? null) ||
        (existing?.address_line2 ?? null) !== (m.address_line2 ?? null)
      ) {
        // The address moved, so every verified fact about it is stale —
        // including the dwelling type and the unit check, which is the whole
        // point: a customer who adds the unit number we asked for must not
        // keep the "no unit number" flag.
        refreshPatch.address_verified_at = null;
        refreshPatch.address_match = null;
        refreshPatch.address_google_formatted = null;
        refreshPatch.address_google_postal = null;
        refreshPatch.address_customer_postal = null;
        refreshPatch.address_verdict = m.address_verdict;
        refreshPatch.address_verdict_source = 'sync-guess';
        refreshPatch.address_unit_status = null;
        refreshPatch.address_validation_granularity = null;
        refreshPatch.address_usps_dpv = null;
        refreshPatch.address_usps_record_type = null;
        refreshPatch.address_is_residential = null;
        refreshPatch.address_is_business = null;
        refreshPatch.address_area_type_error = null;
        addressChanged = true;
      }
    }

    const { error: upErr } = await admin
      .from('orders')
      .update(refreshPatch)
      .eq('order_ref', m.order_ref);
    if (upErr) {
      skipped.push(skipRecord(rawByRef.get(m.order_ref)!, 'db_error', `refresh: ${upErr.message}`));
      return;
    }
    refreshed++;
    if (addressChanged) addressUpdated++;
  });

  // ── Phase 2: customers ─────────────────────────────────────────────────────
  // One write per customer, not one per order: `customers.email` is UNIQUE, so
  // two orders from the same buyer racing each other would have collided, and
  // sequentially they just overwrote each other. The newest order wins, which
  // also makes the result deterministic — it used to be whichever order Shopify
  // happened to return last.
  const newestByEmail = new Map<string, MappedOrder>();
  for (const m of mapped) {
    if (!m.customer_email) continue;
    const key = m.customer_email.toLowerCase();
    const prev = newestByEmail.get(key);
    if (!prev || (m.placed_at ?? '') > (prev.placed_at ?? '')) newestByEmail.set(key, m);
  }

  await mapPool([...newestByEmail.entries()], DB_CONCURRENCY, async ([emailKey, m]) => {
    // Customer upsert: sync phone + address always; fill name only if blank.
    // Never touches operator-curated fields (notes, journey, follow-up statuses).
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
      if (!custErr) customersUpserted++;
    }
  });

  // ── Phase 3: acquisition touches ──────────────────────────────────────────
  // Deliberately after Phase 2. These are UPDATEs keyed on email, so running
  // them before the customer row exists — which is what happened when a
  // first-time buyer's very first order came through — matched nothing and the
  // acquisition source was lost for good, since the order is never "new" again.
  const touchByEmail = new Map<string, MappedOrder>();
  for (const m of mapped) {
    if (!insertedRefs.has(m.order_ref)) continue;
    if (!m.customer_email || !m.attribution_source) continue;
    const key = m.customer_email.toLowerCase();
    const prev = touchByEmail.get(key);
    if (!prev || (m.placed_at ?? '') > (prev.placed_at ?? '')) touchByEmail.set(key, m);
  }

  await mapPool([...touchByEmail.entries()], DB_CONCURRENCY, async ([email, m]) => {
    const at = m.placed_at ?? new Date().toISOString();
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
  });

  const skippedBreakdown = skipped.reduce<Record<string, number>>((acc, sk) => {
    acc[sk.reason] = (acc[sk.reason] ?? 0) + 1;
    return acc;
  }, {});

  return new Response(
    JSON.stringify({
      mode: incremental ? 'incremental' : 'full',
      fetched: orders?.length ?? 0,
      imported,
      refreshed,
      addressUpdated,
      customersUpserted,
      skipped: skipped.length,
      skippedBreakdown,
      journeyBatchesFailed,
      skippedDetails: skipped,
    }),
    { status: 200, headers: { ...corsHeaders, 'content-type': 'application/json' } },
  );
});
