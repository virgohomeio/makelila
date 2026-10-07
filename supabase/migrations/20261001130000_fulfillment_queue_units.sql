-- More than one machine on one order.
--
-- fulfillment_queue.assigned_serial holds exactly one serial, so step 1 could
-- only ever reserve one machine. James San Roman's M-0001 is three LILA Pros:
-- the operator picked a unit, the row advanced to step 2, and the other two
-- were simply not in the system — no reservation, nothing stopping them being
-- sold out from under the order, and at step 6 only the one unit was marked
-- shipped.
--
-- The set of units on a queue row becomes its own table. assigned_serial is
-- KEPT and keeps meaning what it meant — the first unit assigned — because a
-- dozen reads, a FK to units(serial) and this trigger are built on it, and
-- rewriting all of that to ship one feature is how you break the queue for the
-- 158 rows that are already fine. New code reads the child table; old code
-- reading assigned_serial still gets a true answer, just not the whole one.

create table if not exists public.fulfillment_queue_units (
  queue_id    uuid        not null references public.fulfillment_queue(id) on delete cascade,
  unit_serial text        not null references public.units(serial)         on delete cascade,
  assigned_at timestamptz not null default now(),
  assigned_by uuid        references auth.users(id),
  -- Backlog #57's pairing flow: the unit was already 'shipped' when it was
  -- picked, so assigning it must not flip its status. Recorded per unit
  -- because a mixed pick (two off the shelf, one historical) is legitimate.
  is_backfill boolean     not null default false,
  primary key (queue_id, unit_serial)
);

-- "What is this unit on?" is asked from the Stock side as often as the queue
-- side. No UNIQUE on unit_serial: a refurbished machine can genuinely ship
-- twice across two orders, and double-assignment is already prevented where it
-- matters — only a 'ready' unit is pickable, and assigning one reserves it.
create index if not exists fulfillment_queue_units_serial_idx
  on public.fulfillment_queue_units (unit_serial);

alter table public.fulfillment_queue_units enable row level security;

-- Same posture as fulfillment_queue itself: any internal user, all four verbs.
drop policy if exists fulfillment_queue_units_select on public.fulfillment_queue_units;
create policy fulfillment_queue_units_select on public.fulfillment_queue_units
  for select to authenticated using (public.is_internal_user());

drop policy if exists fulfillment_queue_units_insert on public.fulfillment_queue_units;
create policy fulfillment_queue_units_insert on public.fulfillment_queue_units
  for insert to authenticated with check (public.is_internal_user());

drop policy if exists fulfillment_queue_units_update on public.fulfillment_queue_units;
create policy fulfillment_queue_units_update on public.fulfillment_queue_units
  for update to authenticated using (public.is_internal_user()) with check (public.is_internal_user());

drop policy if exists fulfillment_queue_units_delete on public.fulfillment_queue_units;
create policy fulfillment_queue_units_delete on public.fulfillment_queue_units
  for delete to authenticated using (public.is_internal_user());

-- Realtime, so the board sees an assignment the same way it sees a step move.
-- The queue hook's own channel only watches fulfillment_queue, and a pick that
-- adds a second unit does not necessarily touch that row.
do $$
begin
  alter publication supabase_realtime add table public.fulfillment_queue_units;
exception
  when duplicate_object then null;
  when undefined_object then null;
end $$;

-- Every row that already has an assignment gets its child row, so the new
-- table is complete rather than only covering assignments made from today.
-- created_at is the closest honest timestamp we have for when the pick
-- happened; the exact moment was never recorded on the queue row.
insert into public.fulfillment_queue_units (queue_id, unit_serial, assigned_at, is_backfill)
select q.id, q.assigned_serial, coalesce(q.created_at, now()),
       -- A unit that shipped before its queue row was created was paired, not picked.
       coalesce(u.backfilled_at is not null, false)
  from public.fulfillment_queue q
  join public.units u on u.serial = q.assigned_serial
 where q.assigned_serial is not null
on conflict (queue_id, unit_serial) do nothing;

-- The step-6 sync, now over every unit on the row rather than just the first.
--
-- This is the half of the feature that cannot be left for later: assigning
-- three units and then marking one shipped would put the other two in a state
-- no screen admits to — reserved against a delivered order, invisible to Stock
-- as sold and unavailable to sell.
create or replace function public.sync_unit_on_fulfillment()
returns trigger language plpgsql as $$
declare
  o record;
begin
  if new.step <> 6 then return new; end if;
  -- Only fire on transition into step 6 (or a fresh insert at step 6).
  if tg_op = 'UPDATE' and old.step = 6 then return new; end if;

  select customer_name, order_ref, city, region_state, country
    into o
    from public.orders
   where id = new.order_id;

  -- The child table is the source of truth; assigned_serial is unioned in so a
  -- row inserted straight at step 6 (the replacement backfill path in
  -- lib/orders.ts sets assigned_serial inline and writes no child rows) still
  -- syncs its unit.
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
   where serial in (
     select unit_serial from public.fulfillment_queue_units where queue_id = new.id
     union
     select new.assigned_serial where new.assigned_serial is not null
   );

  return new;
end;
$$;
