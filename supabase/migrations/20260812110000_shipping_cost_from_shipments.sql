-- Backlog #58 V5 — get real freight cost onto orders, and keep it there.
--
-- orders.shipping_cost_usd was populated once, by hand, in 20260605040000 (a
-- list of hardcoded order UUIDs). Nothing has written it since, so 141 of 211
-- sale orders and all 46 replacements read as $0.00 shipping on the Customers →
-- Profitability tab — which silently overstates every affected margin.
--
-- Meanwhile public.shipments already holds the answer: all 158 rows carry a
-- billed_amount straight from the Freightcom invoices. The break is in the
-- middle of the chain, not at either end:
--
--   * 65 of 158 shipments have no order_id, stranding $6,835 CAD of freight.
--   * Of those, 45 DO carry a unit_serial, but 44 resolve to a unit whose
--     customer_order_ref is null — so the existing serial pass in
--     match_shipment_orders() cannot walk unit → order.
--   * Nothing at all copies shipments.billed_amount onto the order.
--
-- This migration closes both gaps:
--
--   1. A third match pass. When the serial resolves to a unit that knows its
--      CUSTOMER but not its ORDER, match on the customer instead, subject to the
--      same conservatism as the name pass: the order must be a sale, dated
--      within the window, and EXACTLY ONE candidate may qualify. On today's data
--      this links 37 shipments ($5,140 CAD) and leaves 1 ambiguous shipment
--      alone rather than guessing.
--
--   2. A repeatable propagation of summed shipment cost onto the order, applied
--      by trigger so it stops drifting the way the hand-backfill did.
--
-- DATE GUARD: this pass keys on coalesce(placed_at, created_at), not created_at.
-- The 2026-07-23 Shopify import gave 29 historical orders a created_at of the
-- import date, so a created_at window would reject every one of them. Note the
-- existing match_shipment_orders_by_name() still uses created_at and has the
-- same blind spot — left alone here to keep this migration to one concern.
--
-- MULTI-LEG ORDERS: the cost written is the SUM of every shipment linked to the
-- order, which includes return and reship legs. That is deliberate — it is the
-- true freight we spent serving that customer. It also corrects the hand
-- backfill, which recorded only the outbound leg: 53 of 64 overlapping orders
-- agreed exactly, and the 11 that differed were all multi-leg (e.g. #1131,
-- $167.30 recorded against 3 legs actually totalling $531.80). shipping_legs
-- exposes the count so a multi-leg order is visible rather than surprising.
--
-- CURRENCY: shipments.billed_amount is CAD (every row), so shipping_cost_usd is
-- written with shipping_cost_currency = 'CAD'. The column name remains a
-- misnomer inherited from 20260806170000 — see that migration's note.

-- ── 1. Third match pass: serial → unit → customer → order ───────────────────

alter table public.shipments
  drop constraint if exists shipments_order_match_method_check;

alter table public.shipments
  add constraint shipments_order_match_method_check
  check (order_match_method in ('serial', 'unit_customer', 'customer_name', 'manual'));

comment on column public.shipments.order_match_method is
  'How order_id was determined: serial = via units.customer_order_ref '
  '(authoritative); unit_customer = the serial resolved to a unit that knows '
  'its customer but not its order, and exactly one sale order fit the window; '
  'customer_name = inferred from a unique customer-name + date match; '
  'manual = set by an operator. Null when order_id is null.';

create or replace function public.match_shipment_orders_by_unit_customer()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  matched integer;
begin
  with unlinked as (
    select s.id, s.booked_at, u.customer_id
    from public.shipments s
    join public.units u on u.serial = s.unit_serial
    where s.order_id is null
      and s.booked_at is not null
      and u.customer_id is not null
  ),
  candidates as (
    select ul.id as shipment_id,
           o.id  as order_id,
           count(*) over (partition by ul.id) as n
    from unlinked ul
    join public.orders o
      on o.customer_id = ul.customer_id
     and o.kind = 'sale'
     and coalesce(o.placed_at, o.created_at) <= ul.booked_at + interval '2 days'
     and coalesce(o.placed_at, o.created_at) >= ul.booked_at - interval '120 days'
  )
  update public.shipments s
     set order_id = c.order_id,
         order_match_method = 'unit_customer'
    from candidates c
   where s.id = c.shipment_id
     and c.n = 1              -- ambiguous customers are left alone, on purpose
     and s.order_id is null;

  get diagnostics matched = row_count;
  return matched;
end;
$$;

comment on function public.match_shipment_orders_by_unit_customer() is
  'Third-pass shipment→order linking for shipments whose serial resolves to a '
  'unit with a customer but no customer_order_ref. Only links when exactly one '
  'sale order fits the date window. Returns the number of shipments linked.';

-- Chain the new pass between the serial pass (always wins) and the name pass
-- (weakest key, runs last), so every existing caller picks it up unchanged.
create or replace function public.match_shipment_orders()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.shipments s
  set    order_id = o.id,
         order_match_method = 'serial'
  from   public.units u
  join   public.orders o on o.order_ref = u.customer_order_ref
  where  s.unit_serial = u.serial
    and  s.order_id is null
    and  u.customer_order_ref is not null;

  perform public.match_shipment_orders_by_unit_customer();
  perform public.match_shipment_orders_by_name();
  perform public.apply_order_shipping_from_shipments();
end;
$$;

comment on function public.match_shipment_orders() is
  'Links shipments to orders, then pushes their cost onto the order. '
  'Pass 1: units.customer_order_ref (authoritative). Pass 2: unit customer. '
  'Pass 3: customer name. Then apply_order_shipping_from_shipments(). '
  'Check shipments.order_match_method to see which pass produced a link.';

-- ── 2. Propagate shipment cost onto the order ───────────────────────────────

alter table public.orders
  add column if not exists shipping_cost_basis text;
alter table public.orders
  add column if not exists shipping_legs int;

comment on column public.orders.shipping_cost_basis is
  'How shipping_cost_usd was derived: shipment_actual = summed '
  'shipments.billed_amount from the Freightcom invoices; legacy_backfill = the '
  'hand-entered value from 20260605040000 with no shipment row to confirm it; '
  'manual = operator-entered. NULL alongside a NULL cost means no freight known.';

comment on column public.orders.shipping_legs is
  'Number of shipments summed into shipping_cost_usd. >1 means the order '
  'involved a return or reship leg.';

create or replace function public.apply_order_shipping_from_shipments()
returns table (basis text, rows_touched int)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with summed as (
    select s.order_id,
           sum(s.billed_amount)::numeric(12,2) as cost_cad,
           count(*)::int                       as legs
    from public.shipments s
    where s.order_id is not null
      and s.billed_amount is not null
    group by s.order_id
  ),
  upd as (
    update public.orders o
    set shipping_cost_usd      = m.cost_cad,
        shipping_cost_currency = 'CAD',
        shipping_cost_basis    = 'shipment_actual',
        shipping_legs          = m.legs
    from summed m
    where o.id = m.order_id
      and coalesce(o.shipping_cost_basis, '') <> 'manual'
      and (o.shipping_cost_usd is distinct from m.cost_cad
           or o.shipping_cost_basis is distinct from 'shipment_actual'
           or o.shipping_legs is distinct from m.legs)
    returning 'shipment_actual'::text as b
  ),
  -- Orders carrying a hand-backfilled cost that no shipment row confirms.
  -- Left as-is; only labelled, so the tab can distinguish it from invoice data.
  legacy as (
    update public.orders o
    set shipping_cost_basis = 'legacy_backfill'
    where o.shipping_cost_usd is not null
      and o.shipping_cost_basis is null
      and not exists (select 1 from summed m where m.order_id = o.id)
    returning 'legacy_backfill'::text as b
  )
  select b, count(*)::int from (select b from upd union all select b from legacy) x
  group by b;
end;
$$;

comment on function public.apply_order_shipping_from_shipments() is
  'Repeatable: sums shipments.billed_amount (CAD) per linked order onto '
  'orders.shipping_cost_usd. Preserves operator-entered values '
  '(shipping_cost_basis = manual). Safe to replay.';

-- Keep it current: any shipment insert/update/delete re-costs its order.
create or replace function public.sync_order_shipping_from_shipment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target uuid := coalesce(new.order_id, old.order_id);
begin
  if target is not null then
    update public.orders o
    set shipping_cost_usd      = m.cost_cad,
        shipping_cost_currency = 'CAD',
        shipping_cost_basis    = 'shipment_actual',
        shipping_legs          = m.legs
    from (
      select sum(billed_amount)::numeric(12,2) cost_cad, count(*)::int legs
      from public.shipments
      where order_id = target and billed_amount is not null
    ) m
    where o.id = target
      and coalesce(o.shipping_cost_basis, '') <> 'manual'
      and m.cost_cad is not null;
  end if;
  return null;
end;
$$;

drop trigger if exists shipments_sync_order_shipping on public.shipments;
create trigger shipments_sync_order_shipping
  after insert or update or delete on public.shipments
  for each row execute function public.sync_order_shipping_from_shipment();

-- ── 3. Run both, in order ───────────────────────────────────────────────────

select public.match_shipment_orders_by_unit_customer() as newly_linked;
select * from public.apply_order_shipping_from_shipments();
