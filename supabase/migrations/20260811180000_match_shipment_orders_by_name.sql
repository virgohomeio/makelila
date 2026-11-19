-- Link shipments to orders by customer name when the serial chain can't.
--
-- Why: after loading 157 shipments from the Freightcom portal on 2026-08-11,
-- only 76 carried an order number. The existing match walks
--   shipments.primary_tracking_number → units.tracking_num → units.serial
--   → units.customer_order_ref → orders.order_ref
-- which breaks in two places that no amount of retrying fixes:
--
--   * 45 shipments resolve to a unit whose customer_order_ref is null — the
--     unit was never tied to an order upstream.
--   * 36 shipments match no unit at all. Return labels are structurally in this
--     group: units.tracking_num holds the OUTBOUND tracking number, so a return
--     shipment's tracking can never appear there.
--
-- The customer's name is the signal both paths still have. It is a weaker key
-- than a serial, so this pass is deliberately conservative:
--
--   * exact match on the name, case- and whitespace-insensitive only;
--   * the order must not be newer than the shipment (+2 days' slack for an
--     order placed the same day it shipped);
--   * the order must be within 120 days before the shipment;
--   * and EXACTLY ONE order may satisfy all of the above. Two candidates means
--     we cannot tell which, so the shipment is left unlinked rather than
--     guessed at. On the 2026-08-11 data this dropped 4 shipments.
--
-- Direction decides which party to match: for a return the customer is the
-- SENDER, for an outbound shipment the recipient. Matching the wrong end would
-- try to look up "VCycene Inc." as a customer.
--
-- Links made this way are recorded as 'customer_name' in order_match_method so
-- an operator can tell an inferred link from one derived from a serial. Existing
-- links are backfilled as 'serial' since that is the only route that existed.

alter table public.shipments
  add column if not exists order_match_method text
    check (order_match_method in ('serial', 'customer_name', 'manual'));

comment on column public.shipments.order_match_method is
  'How order_id was determined: serial = via units.serial (authoritative); '
  'customer_name = inferred from a unique customer-name + date match; '
  'manual = set by an operator. Null when order_id is null.';

update public.shipments
   set order_match_method = 'serial'
 where order_id is not null and order_match_method is null;

create or replace function public.match_shipment_orders_by_name()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  matched integer;
begin
  with unlinked as (
    select s.id,
           s.booked_at,
           case when s.raw_payload->>'direction' = 'return'
                then s.raw_payload->>'ship_from_name'
                else s.raw_payload->>'ship_to_name'
           end as party
    from public.shipments s
    where s.order_id is null
      and s.booked_at is not null
  ),
  candidates as (
    select u.id as shipment_id,
           o.id as order_id,
           count(*) over (partition by u.id) as n
    from unlinked u
    join public.orders o
      on lower(btrim(o.customer_name)) = lower(btrim(u.party))
     and o.created_at <= u.booked_at + interval '2 days'
     and o.created_at >= u.booked_at - interval '120 days'
    where u.party is not null and btrim(u.party) <> ''
  )
  update public.shipments s
     set order_id = c.order_id,
         order_match_method = 'customer_name'
    from candidates c
   where s.id = c.shipment_id
     and c.n = 1               -- ambiguous names are left alone, on purpose
     and s.order_id is null;

  get diagnostics matched = row_count;
  return matched;
end;
$$;

comment on function public.match_shipment_orders_by_name() is
  'Second-pass shipment→order linking on customer name, for shipments the '
  'serial chain cannot reach (notably returns). Only links when exactly one '
  'order matches. Returns the number of shipments linked.';

-- The name pass is chained onto the serial pass rather than exposed as a second
-- call, so every existing caller — sync-freightcom-shipments and
-- scripts/import-freightcom-tracking.mjs — picks it up with no code change. The
-- serial pass runs first and always wins; the name pass only ever sees what it
-- left unlinked.
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

  perform public.match_shipment_orders_by_name();
end;
$$;

comment on function public.match_shipment_orders() is
  'Links shipments to orders. Pass 1: via units.serial (authoritative). '
  'Pass 2: match_shipment_orders_by_name(), a conservative customer-name match '
  'for what pass 1 cannot reach. Check shipments.order_match_method to see '
  'which produced a given link.';
