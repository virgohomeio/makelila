-- (a) Link service tickets to a warranty registration for audit + display.
alter table public.service_tickets
  add column if not exists warranty_registration_id uuid
    references public.warranty_registrations(id);

-- (b) Replacement warranty child row.
-- When a replacement order is fulfilled (fulfillment step 6), insert a child
-- warranty_registrations row for the replacement unit with
-- coverage_tier = 'replacement_no_warranty', pointing back to the original
-- unit's registration via parent_registration_id.
--
-- The replacement_workflow migration (20260604210000) does not add its own
-- fulfillment trigger — it uses the same fq_sync_unit trigger which calls
-- sync_unit_on_fulfillment(). The standard_1y row for a replacement unit
-- would already be inserted by the extended trigger above (migration
-- 20260610130100), but replacement units should get 'replacement_no_warranty'
-- instead. We handle this by adding a second pass in a new trigger that fires
-- AFTER the unit row is updated to 'shipped' and the replacement row exists.
--
-- Simpler alternative chosen: extend sync_unit_on_fulfillment() to detect
-- when the order is a replacement (orders.kind = 'replacement') and use
-- 'replacement_no_warranty' + set parent_registration_id from the original
-- unit's registration. The ON CONFLICT DO NOTHING in migration 130100 means
-- only the first applicable branch wins — so we must do the tier selection
-- there. We add a new replacement-aware version below, replacing 130100's
-- function a second time so the final function includes both branches.

create or replace function public.sync_unit_on_fulfillment()
returns trigger language plpgsql as $$
declare
  o record;
  cust_id uuid;
  orig_order_id uuid;
  orig_reg_id uuid;
  w_tier text;
begin
  if new.assigned_serial is null then return new; end if;
  if new.step <> 6 then return new; end if;
  if tg_op = 'UPDATE' and old.step = 6 then return new; end if;

  select customer_name, order_ref, city, region_state, country,
         customer_id, customer_email, kind, linked_ticket_id
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

  if cust_id is null then
    return new;  -- cannot create a warranty without a customer
  end if;

  -- Determine tier and parent for replacement orders.
  if o.kind = 'replacement' then
    w_tier := 'replacement_no_warranty';

    -- Find the original order via the linked service ticket → original unit.
    -- The replacement order links back to a service ticket which has a
    -- unit_serial. Look up that unit's warranty registration.
    if o.linked_ticket_id is not null then
      select wr.id into orig_reg_id
        from public.service_tickets st
        join public.warranty_registrations wr on wr.unit_serial = st.unit_serial
       where st.id = o.linked_ticket_id
       limit 1;
    end if;
  else
    w_tier := 'standard_1y';
    orig_reg_id := null;
  end if;

  insert into public.warranty_registrations (
    unit_serial,
    customer_id,
    original_order_id,
    coverage_tier,
    coverage_start,
    parent_registration_id,
    registered_by
  ) values (
    new.assigned_serial,
    cust_id,
    new.order_id,
    w_tier,
    current_date,
    orig_reg_id,
    auth.uid()
  )
  on conflict (unit_serial) do nothing;

  return new;
end;
$$;
