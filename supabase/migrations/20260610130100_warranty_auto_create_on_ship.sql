-- Extend sync_unit_on_fulfillment() to also create a warranty_registrations
-- row when the fulfillment queue transitions to step 6 (fulfilled/shipped).
--
-- The existing trigger (20260420310000_sync_unit_on_fulfillment.sql) fires
-- AFTER INSERT OR UPDATE on fulfillment_queue for each row. We replace the
-- function in-place so the same trigger continues to call it — no need for
-- a new trigger object.
--
-- Customer lookup mirrors the existing pattern: orders.customer_id if set,
-- else best-effort via orders.customer_email → customers.email.

create or replace function public.sync_unit_on_fulfillment()
returns trigger language plpgsql as $$
declare
  o record;
  cust_id uuid;
begin
  if new.assigned_serial is null then return new; end if;
  if new.step <> 6 then return new; end if;
  -- Only fire on transition into step 6 (or fresh insert at step 6)
  if tg_op = 'UPDATE' and old.step = 6 then return new; end if;

  select customer_name, order_ref, city, region_state, country,
         customer_id, customer_email
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

  -- ----------------------------------------------------------------
  -- Auto-create warranty registration
  -- ----------------------------------------------------------------
  -- Resolve customer_id: prefer the FK on orders, fall back to email match.
  cust_id := o.customer_id;
  if cust_id is null and o.customer_email is not null then
    select c.id into cust_id
      from public.customers c
     where lower(c.email) = lower(o.customer_email)
     limit 1;
  end if;

  if cust_id is not null then
    insert into public.warranty_registrations (
      unit_serial,
      customer_id,
      original_order_id,
      coverage_tier,
      coverage_start,
      registered_by
    ) values (
      new.assigned_serial,
      cust_id,
      new.order_id,
      'standard_1y',
      current_date,
      auth.uid()
    )
    on conflict (unit_serial) do nothing;
  end if;

  return new;
end;
$$;

-- The existing trigger (fq_sync_unit) still points to this function —
-- no need to recreate it.
