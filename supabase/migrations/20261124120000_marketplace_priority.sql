-- Marketplace orders (Walmart, Best Buy, Mirakl): automatic queue priority, and
-- the alert email sent when sync-shopify-orders first sees one.
--
-- Process change "LILA - Updated Fulfillment Processes" (effective
-- 2026-11-19), Huayi's build order items 1 and 3. Marketplaces cancel an order
-- that is not marked shipped by its Seller Center Ship By date, so these orders
-- have to be at the top of the queue from the moment they are confirmed.
--
-- Safe to re-run. Apply by hand (never `supabase db push`, the migration
-- history has diverged).
--
-- ── 1. Which channels are marketplaces ────────────────────────────────────
-- SQL twin of supabase/functions/_shared/marketplace.ts (marketplaceOf). Reads
-- orders.sales_channel, the label sync-shopify-orders resolves from Shopify's
-- source_name: 'Walmart', 'Best Buy', 'Marketplace (Mirakl)'. Shopify
-- Collective is a reseller but has no Ship By deadline, so it is not included.
create or replace function public.is_marketplace_channel(channel text)
returns boolean
language sql
immutable
as $$
  select coalesce(
    lower(channel) like '%walmart%'
    or lower(channel) like '%best buy%'
    or lower(channel) like '%bestbuy%'
    or lower(channel) like '%mirakl%',
    false);
$$;

comment on function public.is_marketplace_channel(text) is
  'True for a Walmart, Best Buy or Mirakl orders.sales_channel label. Keep in step with supabase/functions/_shared/marketplace.ts.';

-- ── 2. Enqueue with priority ──────────────────────────────────────────────
-- Same trigger body as 20260904120000_refunded_orders_never_enqueue.sql (the
-- refund guard), plus priority for a marketplace order.
--
-- NOTE for whoever applies this: as of 2026-11-24 the LIVE function is still
-- the original 20260419231345 version, without the refund guard; that
-- 2026-09-04 migration was never applied. Applying this one brings the guard
-- in too. refund_approvals.order_id exists in prod, so the guard is safe to
-- run. The app already refuses to confirm an order-level refund
-- (lib/orders.ts assertNotRefunded), so this changes nothing an operator can
-- reach from the app.
--
-- due_date stays at 7 days here. A marketplace order's real Ship By date is
-- entered at Confirm (Sales) and written over this by the app
-- (lib/marketplace.ts setMarketplaceShipBy) once the row exists.
create or replace function public.auto_enqueue_approved_order()
returns trigger
language plpgsql
as $function$
declare
  refunded boolean;
begin
  if new.status = 'approved' and (old.status is null or old.status <> 'approved') then
    select exists (
      select 1 from public.refund_approvals ra
       where ra.order_id = new.id
         and ra.status not in ('denied', 'closed')
    ) into refunded;

    if refunded then
      raise notice 'Order % not enqueued: it has a refund against it', new.order_ref;
      return new;
    end if;

    insert into public.fulfillment_queue (order_id, due_date, priority)
    values (
      new.id,
      (now() + interval '7 days')::date,
      public.is_marketplace_channel(new.sales_channel)
    )
    on conflict (order_id) do nothing;
  end if;
  return new;
end;
$function$;

-- ── 3. Backfill: marketplace rows already in the queue, not yet shipped ────
-- 2026-11-24: #1363, #1360 (step 3), #1359, #1356, #1349 (step 5). Shipped rows
-- (step 6) are left alone; priority means nothing once the box is gone.
update public.fulfillment_queue q
   set priority = true
  from public.orders o
 where o.id = q.order_id
   and q.step < 6
   and q.priority = false
   and public.is_marketplace_channel(o.sales_channel);

-- ── 4. Arrival alert template ─────────────────────────────────────────────
-- Sent by sync-shopify-orders the first time it inserts a marketplace order,
-- before anyone confirms it. Recipients: MARKETPLACE_ALERT_TO on the edge
-- function, else the defaults in _shared/marketplace.ts. The function has
-- built-in fallback copy, so a missing row still sends; this row makes the
-- copy editable in Templates.
insert into public.email_templates (key, name, category, description, subject, body, variables, channel, active)
values (
  'marketplace_order_arrived',
  'Marketplace order arrived — internal alert',
  'order_review',
  'Internal alert when a Walmart, Best Buy or Mirakl order first syncs from Shopify, before it is confirmed. Reminds the team to look up the Ship By date.',
  'New {{marketplace}} order {{order_ref}}: check its Ship By date',
  E'A new {{marketplace}} order just reached makeLILA.\n\nOrder: {{order_ref}}\nCustomer: {{customer_name}}\nShip to: {{destination}}\nTotal: {{amount}}\nPlaced: {{placed_at}}\n\nLook up its Ship By date in Seller Center, then confirm it in Sales > Pending (filter: Marketplace) and enter that date. The marketplace cancels orders that are not marked shipped by then.\n\nOpen Sales: {{sales_url}}\n\n— makeLILA',
  array['marketplace','order_ref','customer_name','destination','amount','placed_at','sales_url']::text[],
  'email',
  true
)
on conflict (key) do nothing;
