-- Retained-unit cost needs a team flag before anyone quotes the total.
--
-- V15 moved every cancelled sale order's cost onto public.retained_unit_costs.
-- Seven of the twenty belong to Pedrum -- #1013, #1014, #1089, #1101, #1105,
-- #1106, #1193 -- carrying $6,052.78, which is 41% of the line. Those look like
-- test orders rather than machines that were built and kept: none has a
-- shipment, none has a traced unit, and several were placed and cancelled the
-- same day with a $3 total against a full $913.89 schedule COGS.
--
-- Whether they are real is not a question this migration can answer, and
-- guessing either way breaks a rule. Dropping them would hide cost if the
-- machines were genuinely built; leaving them silently inside the total would
-- invent cost if they were not. So the view reports the split and the tab shows
-- both figures, the same way an unpriced bucket reads 0 next to the word
-- "unpriced" rather than being quietly omitted.
--
-- Same team predicate as customer_profitability.is_team_member, deliberately --
-- two definitions of "is this one of ours" would drift.

create or replace view public.retained_unit_costs as
select
  o.id                                                              as order_id,
  o.order_ref,
  o.customer_name,
  o.placed_at,
  o.cancelled_at,
  o.cogs_basis,
  coalesce(public.to_cad(o.cogs_usd, 'USD'), 0)::numeric(12,2)      as cogs_cad,
  coalesce(
    (select sum(coalesce(sic.applicable_cad, s.billed_amount))
       from public.shipments s
       left join public.shipment_invoiced_charges sic
         on sic.tracking_number = s.primary_tracking_number
      where s.order_id = o.id),
    public.to_cad(o.shipping_cost_usd, coalesce(o.shipping_cost_currency, 'CAD')),
    0
  )::numeric(12,2)                                                  as freight_cad,
  (select coalesce(sum((li->>'qty')::numeric), 1)
     from jsonb_array_elements(coalesce(o.line_items, '[]'::jsonb)) li)::int
                                                                    as units_retained,
  exists (
    select 1 from public.team_invite_list t
    where lower(t.display_name) = lower(o.customer_name)
       or lower(o.customer_name) like lower(t.display_name) || ' %'
  )                                                                 as is_team_member
from public.orders o
where o.kind = 'sale'
  and (coalesce(o.status, '') = 'cancelled' or o.cancelled_at is not null);

alter view public.retained_unit_costs set (security_invoker = true);

grant select on public.retained_unit_costs to authenticated;

comment on view public.retained_unit_costs is
  'Backlog #58 V15: cost of machines built for orders that were later cancelled. The '
  'customer account was credited and the unit returned to stock, so this cost belongs to '
  'no customer -- it is reported company-wide, outside contribution margin. is_team_member '
  'separates cancelled orders placed on internal accounts, which are likely tests rather '
  'than machines; the tab shows the two figures separately.';
