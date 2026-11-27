// Push fulfillment data from our DB up to Shopify, marking each order
// as fulfilled with tracking info. Inverse of sync-shopify-orders.
//
// Two modes:
//
//   { queue_id }  — one row. Called automatically by the app the moment an
//                   operator confirms pickup (lib/fulfillment.ts confirmDock),
//                   and by the Retry button on the Fulfilled panel. Tracking is
//                   optional here: an order that left without a number is
//                   still fulfilled in Shopify, just without a tracking link.
//
//   {}            — bulk sweep of every fulfilled queue row with a tracking
//                   number (PostShipment › History "Push fulfillments" button).
//                   Backfill / catch-up for anything the per-row push missed.
//
// For each row we:
//   1. Skip replacements — makeLILA-only orders with no Shopify counterpart
//   2. Look up the matching Shopify order by `name` (e.g. "#1239")
//   3. Skip if Shopify already shows it fulfilled
//   4. Fetch the order's fulfillment_orders and POST one fulfillment covering
//      every open line item, with tracking number / carrier / tracking URL
//   5. Record the outcome on fulfillment_queue.shopify_fulfilled_at /
//      shopify_sync_error (20261117120000). Best-effort: on a database that
//      has not run that migration the push still happens, it just isn't
//      recorded.
//
// notify_customer is false: makeLILA sends its own shipment email at step 4.
//
// Env: SHOPIFY_SHOP_DOMAIN, SHOPIFY_ADMIN_TOKEN (already configured
//      for sync-shopify-orders). The Admin token needs the
//      write_merchant_managed_fulfillment_orders scope to create fulfillments.

import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { corsHeaders } from '../_shared/cors.ts';
import { authenticate } from '../_shared/auth.ts';

const API_VERSION = '2024-10';

type ShopifyOrder = {
  id: number;
  name: string;
  fulfillment_status: string | null;
};

type FulfillmentOrder = {
  id: number;
  status: string;          // 'open', 'in_progress', 'closed', 'incomplete', 'cancelled', 'scheduled', 'on_hold'
  line_items: { id: number; quantity: number }[];
};

type QueueRow = {
  id: string;
  order_id: string;
  step: number;
  fulfilled_at: string | null;
  carrier: string | null;
  tracking_num: string | null;
  orders: { order_ref: string; kind: string | null } | null;
};

type Outcome =
  | { status: 'pushed' }
  | { status: 'already_fulfilled' }
  | { status: 'skipped'; reason: string; record: boolean }
  | { status: 'failed'; error: string };

const QUEUE_SELECT = 'id, order_id, step, fulfilled_at, carrier, tracking_num, orders:order_id(order_ref, kind)';

/** Mirrors trackingUrlFor() in app/src/lib/fulfillment.ts and trackingUrl()
 *  in send-fulfillment-email. Passed to Shopify so the order's tracking link
 *  works even for a carrier name Shopify doesn't recognise. */
function trackingUrl(carrier: string | null, tracking: string): string | undefined {
  const t = encodeURIComponent(tracking);
  switch (carrier) {
    case 'UPS':          return `https://www.ups.com/track?tracknum=${t}`;
    case 'FedEx':        return `https://www.fedex.com/fedextrack/?trknbr=${t}`;
    case 'Purolator':    return `https://www.purolator.com/en/shipping/tracker?pin=${t}`;
    case 'Canada Post':  return `https://www.canadapost-postescanada.ca/track-reperage/en#/search?searchFor=${t}`;
    case 'Canpar':       return `https://www.canpar.com/en/track/TrackingAction.do?reference=${t}`;
    case 'GLS':          return `https://gls-us.com/tracking?trackingNumber=${t}`;
    case 'Day & Ross':   return 'https://dayross.com/track-shipments';
    default:             return undefined;
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'content-type': 'application/json' },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders });
  }
  try { return await handle(req); }
  catch (err) {
    return json(500, { error: `Uncaught: ${(err as Error)?.message ?? String(err)}` });
  }
});

async function handle(req: Request): Promise<Response> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const shop = Deno.env.get('SHOPIFY_SHOP_DOMAIN');
  const token = Deno.env.get('SHOPIFY_ADMIN_TOKEN');
  if (!supabaseUrl || !serviceKey || !shop || !token) {
    return json(500, { error: 'Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SHOPIFY_SHOP_DOMAIN / SHOPIFY_ADMIN_TOKEN' });
  }

  const admin = createClient(supabaseUrl, serviceKey);

  let _caller;
  try { _caller = await authenticate(req, admin); }
  catch (e) { if (e instanceof Response) return e; throw e; }
  // Reject cron-secret calls — these functions are operator-triggered only.
  if (_caller.kind !== 'user') {
    return json(403, { error: 'This function requires an operator JWT — cron-secret not accepted.' });
  }

  // Optional payload: { queue_id?: string, dry_run?: boolean, limit?: number }
  let body: { queue_id?: string; dry_run?: boolean; limit?: number } = {};
  try { body = await req.json(); } catch { /* no body, that's fine */ }
  const dryRun = body.dry_run === true;
  const shopify = { shop, token };

  // ── Single row ────────────────────────────────────────────────────────────
  if (body.queue_id) {
    const { data, error } = await admin
      .from('fulfillment_queue')
      .select(QUEUE_SELECT)
      .eq('id', body.queue_id)
      .maybeSingle();
    if (error) return json(500, { error: `DB read failed: ${error.message}` });
    if (!data) return json(404, { error: 'Queue row not found' });
    const row = data as unknown as QueueRow;
    if (row.step !== 6 && !row.fulfilled_at) {
      return json(409, { error: 'This order is not fulfilled in makeLILA yet.' });
    }
    const outcome = await pushOne(row, shopify, dryRun, false);
    if (!dryRun) await record(admin, row.id, outcome);
    return json(200, { order_ref: row.orders?.order_ref ?? null, dry_run: dryRun, ...outcome });
  }

  // ── Bulk sweep ────────────────────────────────────────────────────────────
  const limit = Math.max(1, Math.min(500, body.limit ?? 500));
  const { data: candidates, error: candErr } = await admin
    .from('fulfillment_queue')
    .select(QUEUE_SELECT)
    .or('step.eq.6,fulfilled_at.not.is.null')
    .not('tracking_num', 'is', null)
    .limit(limit);
  if (candErr) return json(500, { error: `DB read failed: ${candErr.message}` });

  const rows = (candidates ?? []) as unknown as QueueRow[];
  const result = {
    candidates: rows.length,
    pushed: 0,
    already_fulfilled: 0,
    skipped: [] as { order_ref: string; reason: string }[],
    failed: [] as { order_ref: string; error: string }[],
    dry_run: dryRun,
  };

  for (const r of rows) {
    const orderRef = r.orders?.order_ref ?? '(missing)';
    const outcome = await pushOne(r, shopify, dryRun, true);
    if (!dryRun) await record(admin, r.id, outcome);
    if (outcome.status === 'pushed') result.pushed++;
    else if (outcome.status === 'already_fulfilled') result.already_fulfilled++;
    else if (outcome.status === 'skipped') result.skipped.push({ order_ref: orderRef, reason: outcome.reason });
    else result.failed.push({ order_ref: orderRef, error: outcome.error });
  }

  return json(200, result);
}

async function pushOne(
  r: QueueRow,
  { shop, token }: { shop: string; token: string },
  dryRun: boolean,
  requireTracking: boolean,
): Promise<Outcome> {
  const orderRef = r.orders?.order_ref;
  if (r.orders?.kind === 'replacement') {
    return { status: 'skipped', reason: 'replacement — not a Shopify order', record: false };
  }
  if (!orderRef) return { status: 'skipped', reason: 'no order_ref', record: true };
  if (requireTracking && !r.tracking_num) {
    return { status: 'skipped', reason: 'no tracking number', record: false };
  }

  const headers = { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' };
  try {
    // 1. Find the Shopify order by name.
    const shopifyName = orderRef.startsWith('#') ? orderRef : `#${orderRef}`;
    const lookupUrl = `https://${shop}/admin/api/${API_VERSION}/orders.json?name=${encodeURIComponent(shopifyName)}&status=any&fields=id,name,fulfillment_status`;
    const lookupRes = await fetch(lookupUrl, { headers });
    if (!lookupRes.ok) return { status: 'failed', error: `Shopify order lookup failed (${lookupRes.status})` };
    const lookupJson = await lookupRes.json() as { orders?: ShopifyOrder[] };
    // name= is a prefix-ish search on some API versions; insist on the exact name.
    const sOrder = (lookupJson.orders ?? []).find(o => o.name === shopifyName);
    if (!sOrder) return { status: 'skipped', reason: `order ${shopifyName} not found in Shopify`, record: true };
    if (sOrder.fulfillment_status === 'fulfilled') return { status: 'already_fulfilled' };
    if (dryRun) return { status: 'pushed' }; // would-push

    // 2. Get fulfillment_orders for this Shopify order.
    const foRes = await fetch(`https://${shop}/admin/api/${API_VERSION}/orders/${sOrder.id}/fulfillment_orders.json`, { headers });
    if (!foRes.ok) return { status: 'failed', error: `Shopify fulfillment_orders failed (${foRes.status})` };
    const foJson = await foRes.json() as { fulfillment_orders?: FulfillmentOrder[] };
    const openFOs = (foJson.fulfillment_orders ?? []).filter(fo =>
      fo.status === 'open' || fo.status === 'in_progress' || fo.status === 'scheduled'
    );
    if (openFOs.length === 0) {
      return { status: 'skipped', reason: 'Shopify has no open items left to fulfill on this order', record: true };
    }

    // 3. POST the fulfillment.
    const fulfillment: Record<string, unknown> = {
      line_items_by_fulfillment_order: openFOs.map(fo => ({
        fulfillment_order_id: fo.id,
        fulfillment_order_line_items: fo.line_items.map(li => ({ id: li.id, quantity: li.quantity })),
      })),
      notify_customer: false,
    };
    if (r.tracking_num) {
      fulfillment.tracking_info = {
        number: r.tracking_num,
        company: r.carrier ?? undefined,
        url: trackingUrl(r.carrier, r.tracking_num),
      };
    }
    const postRes = await fetch(`https://${shop}/admin/api/${API_VERSION}/fulfillments.json`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ fulfillment }),
    });
    if (!postRes.ok) {
      const errBody = await postRes.text();
      const hint = postRes.status === 401 || postRes.status === 403
        ? ' — the Shopify app token may be missing the write_merchant_managed_fulfillment_orders scope'
        : '';
      return { status: 'failed', error: `Shopify fulfillment POST ${postRes.status}${hint}: ${errBody.slice(0, 200)}` };
    }
    return { status: 'pushed' };
  } catch (e) {
    return { status: 'failed', error: (e as Error).message };
  }
}

/** Write the outcome onto the queue row. Best-effort — a failure here (e.g.
 *  the columns don't exist yet) must not turn a successful push into an error. */
async function record(admin: SupabaseClient, queueId: string, o: Outcome): Promise<void> {
  let patch: Record<string, unknown> | null = null;
  if (o.status === 'pushed' || o.status === 'already_fulfilled') {
    patch = { shopify_fulfilled_at: new Date().toISOString(), shopify_sync_error: null };
  } else if (o.status === 'failed') {
    patch = { shopify_sync_error: o.error };
  } else if (o.record) {
    patch = { shopify_sync_error: o.reason };
  }
  if (!patch) return;
  // Never overwrite an existing success with a later skip/failure.
  let q = admin.from('fulfillment_queue').update(patch).eq('id', queueId);
  if (!('shopify_fulfilled_at' in patch)) q = q.is('shopify_fulfilled_at', null);
  const { error } = await q;
  if (error) console.warn(`record shopify outcome for ${queueId} failed:`, error.message);
}
