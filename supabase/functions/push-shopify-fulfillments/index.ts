// Push fulfillment data from our DB up to Shopify, marking each order
// as fulfilled with tracking info. Inverse of sync-shopify-orders.
//
// What gets pushed: every public.orders row that has a corresponding
// public.fulfillment_queue row at step=6 (or fulfilled_at IS NOT NULL),
// or whose customer has any unit in status='shipped'. For each, we:
//   1. Look up the matching Shopify order by `name` (e.g. "#1239")
//   2. Skip if Shopify already shows it fulfilled
//   3. Fetch the order's fulfillment_orders (Shopify wraps line items
//      per location for fulfillment)
//   4. POST a new fulfillment with tracking_number + tracking_company
//
// Env: SHOPIFY_SHOP_DOMAIN, SHOPIFY_ADMIN_TOKEN (already configured
//      for sync-shopify-orders)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { corsHeaders } from '../_shared/cors.ts';

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

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders });
  }
  try { return await handle(req); }
  catch (err) {
    return new Response(
      JSON.stringify({ error: `Uncaught: ${(err as Error)?.message ?? String(err)}` }),
      { status: 500, headers: { ...corsHeaders, 'content-type': 'application/json' } },
    );
  }
});

async function handle(req: Request): Promise<Response> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const shop = Deno.env.get('SHOPIFY_SHOP_DOMAIN');
  const token = Deno.env.get('SHOPIFY_ADMIN_TOKEN');
  if (!supabaseUrl || !serviceKey || !shop || !token) {
    return new Response(
      JSON.stringify({ error: 'Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SHOPIFY_SHOP_DOMAIN / SHOPIFY_ADMIN_TOKEN' }),
      { status: 500, headers: { ...corsHeaders, 'content-type': 'application/json' } },
    );
  }

  // Optional payload: { dry_run?: boolean, limit?: number }
  let body: { dry_run?: boolean; limit?: number } = {};
  try { body = await req.json(); } catch { /* no body, that's fine */ }
  const dryRun = body.dry_run === true;
  const limit = Math.max(1, Math.min(500, body.limit ?? 500));

  const admin = createClient(supabaseUrl, serviceKey);

  // Pull candidates: orders whose fulfillment_queue is at step=6 with tracking,
  // joined with the order's order_ref + customer_name.
  const { data: candidates, error: candErr } = await admin
    .from('fulfillment_queue')
    .select('order_id, step, fulfilled_at, carrier, tracking_num, orders:order_id(order_ref, customer_name, customer_email)')
    .or('step.eq.6,fulfilled_at.not.is.null')
    .not('tracking_num', 'is', null)
    .limit(limit);

  if (candErr) {
    return new Response(
      JSON.stringify({ error: `DB read failed: ${candErr.message}` }),
      { status: 500, headers: { ...corsHeaders, 'content-type': 'application/json' } },
    );
  }

  const rows = (candidates ?? []) as Array<{
    order_id: string;
    step: number;
    fulfilled_at: string | null;
    carrier: string | null;
    tracking_num: string | null;
    orders: { order_ref: string; customer_name: string; customer_email: string | null } | null;
  }>;

  const result = {
    candidates: rows.length,
    pushed: 0,
    already_fulfilled: 0,
    skipped: [] as { order_ref: string; reason: string }[],
    failed: [] as { order_ref: string; error: string }[],
    dry_run: dryRun,
  };

  for (const r of rows) {
    const orderRef = r.orders?.order_ref;
    if (!orderRef || !r.tracking_num) {
      result.skipped.push({ order_ref: orderRef ?? '(missing)', reason: 'no order_ref or tracking' });
      continue;
    }

    try {
      // 1. Find the Shopify order by name. Strip leading '#' if present.
      const shopifyName = orderRef.startsWith('#') ? orderRef : `#${orderRef}`;
      const lookupUrl = `https://${shop}/admin/api/${API_VERSION}/orders.json?name=${encodeURIComponent(shopifyName)}&status=any&fields=id,name,fulfillment_status`;
      const lookupRes = await fetch(lookupUrl, {
        headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
      });
      if (!lookupRes.ok) {
        result.failed.push({ order_ref: orderRef, error: `lookup ${lookupRes.status}` });
        continue;
      }
      const lookupJson = await lookupRes.json() as { orders?: ShopifyOrder[] };
      const sOrder = lookupJson.orders?.[0];
      if (!sOrder) {
        result.skipped.push({ order_ref: orderRef, reason: 'order not found in Shopify' });
        continue;
      }
      if (sOrder.fulfillment_status === 'fulfilled') {
        result.already_fulfilled++;
        continue;
      }

      if (dryRun) {
        result.pushed++; // would-push
        continue;
      }

      // 2. Get fulfillment_orders for this Shopify order
      const foUrl = `https://${shop}/admin/api/${API_VERSION}/orders/${sOrder.id}/fulfillment_orders.json`;
      const foRes = await fetch(foUrl, {
        headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
      });
      if (!foRes.ok) {
        result.failed.push({ order_ref: orderRef, error: `fulfillment_orders ${foRes.status}` });
        continue;
      }
      const foJson = await foRes.json() as { fulfillment_orders?: FulfillmentOrder[] };
      const openFOs = (foJson.fulfillment_orders ?? []).filter(fo =>
        fo.status === 'open' || fo.status === 'in_progress' || fo.status === 'scheduled'
      );
      if (openFOs.length === 0) {
        result.skipped.push({ order_ref: orderRef, reason: 'no open fulfillment_orders' });
        continue;
      }

      // 3. POST the fulfillment using the new fulfillment-orders API
      const fulfillmentBody = {
        fulfillment: {
          line_items_by_fulfillment_order: openFOs.map(fo => ({
            fulfillment_order_id: fo.id,
            // Fulfill all open line items in this fulfillment order
            fulfillment_order_line_items: fo.line_items.map(li => ({
              id: li.id,
              quantity: li.quantity,
            })),
          })),
          tracking_info: {
            number: r.tracking_num,
            company: r.carrier ?? undefined,
          },
          notify_customer: false,
        },
      };
      const postUrl = `https://${shop}/admin/api/${API_VERSION}/fulfillments.json`;
      const postRes = await fetch(postUrl, {
        method: 'POST',
        headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
        body: JSON.stringify(fulfillmentBody),
      });
      if (!postRes.ok) {
        const errBody = await postRes.text();
        result.failed.push({ order_ref: orderRef, error: `fulfillment POST ${postRes.status}: ${errBody.slice(0, 200)}` });
        continue;
      }
      result.pushed++;
    } catch (e) {
      result.failed.push({ order_ref: orderRef, error: (e as Error).message });
    }
  }

  return new Response(
    JSON.stringify(result),
    { status: 200, headers: { ...corsHeaders, 'content-type': 'application/json' } },
  );
}
