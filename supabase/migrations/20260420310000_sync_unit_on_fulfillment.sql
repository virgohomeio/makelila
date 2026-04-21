-- Sync fulfillment_queue → units when a queue row hits step 6 (fulfilled).
-- Without this, new app-driven shipments only live in fulfillment_queue and
-- never reach the units table, so the Stock module + Post-Shipment History
-- tab miss them.
--
-- The trigger fires on transition into step 6 (or fresh insert at step 6),
-- looks up the order's customer_name + city/region, and updates the units
-- row identified by assigned_serial:
--   status        → 'shipped'
--   customer_name + customer_order_ref ← orders
--   location      ← "City, REGION"
--   carrier       ← queue carrier
--   shipped_at    ← fulfilled_at (or now())

create or replace function public.sync_unit_on_fulfillment()
returns trigger language plpgsql as $$
declare
  o record;
begin
  if new.assigned_serial is null then return new; end if;
  if new.step <> 6 then return new; end if;
  -- Only fire on transition into step 6 (or fresh insert at step 6)
  if tg_op = 'UPDATE' and old.step = 6 then return new; end if;

  select customer_name, order_ref, city, region_state, country
    into o
    from public.orders
   where id = new.order_id;

  update public.units set
    status             = 'shipped',
    customer_name      = coalesce(o.customer_name, customer_name),
    customer_order_ref = coalesce(o.order_ref, customer_order_ref),
    carrier            = coalesce(new.carrier, carrier),
    location           = case
      when o.city is not null and o.region_state is not null
        then o.city || ', ' || o.region_state
      when o.city is not null then o.city
      else location
    end,
    shipped_at         = coalesce(new.fulfilled_at, now())
   where serial = new.assigned_serial;

  return new;
end;
$$;

drop trigger if exists fq_sync_unit on public.fulfillment_queue;
create trigger fq_sync_unit
  after insert or update on public.fulfillment_queue
  for each row execute function public.sync_unit_on_fulfillment();

-- Back-fill: run the same logic for queue rows already at step 6 whose unit
-- still isn't reflecting it.
update public.units u set
  status             = 'shipped',
  customer_name      = coalesce(o.customer_name, u.customer_name),
  customer_order_ref = coalesce(o.order_ref, u.customer_order_ref),
  carrier            = coalesce(q.carrier, u.carrier),
  location           = case
    when o.city is not null and o.region_state is not null
      then o.city || ', ' || o.region_state
    when o.city is not null then o.city
    else u.location
  end,
  shipped_at         = coalesce(q.fulfilled_at, u.shipped_at)
from public.fulfillment_queue q
join public.orders o on o.id = q.order_id
where q.step = 6
  and q.assigned_serial = u.serial
  and u.status <> 'shipped';
