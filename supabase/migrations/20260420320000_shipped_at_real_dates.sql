-- Make units.shipped_at reflect actual ship dates, not migration-run time.
--
-- Two parts:
--
-- 1. Update sync_unit_on_fulfillment so app-driven shipments stamp
--    shipped_at = label_confirmed_at (Step 3 — when label is printed and
--    unit physically ships). Falls back to fulfilled_at (Step 5/6 — email
--    sent) and finally now() if neither is set.
--
-- 2. Back-fill historical units (the seeded P50/P150/P50N rows) by
--    extracting the first YYYY-MM-DD pattern from the notes column —
--    the snapshot migration captured ship/received dates as plain text
--    inside notes (e.g. "MaxxUs · received 2025-10-22"). Use that date
--    instead of the back-fill-from-status_updated_at value, which all
--    landed at migration-run timestamp.

-- ============================================================================
-- 1. Refine the sync trigger
-- ============================================================================
create or replace function public.sync_unit_on_fulfillment()
returns trigger language plpgsql as $$
declare
  o record;
begin
  if new.assigned_serial is null then return new; end if;
  if new.step <> 6 then return new; end if;
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
    -- Prefer label-confirmed time (Step 3 = unit physically shipped) over
    -- fulfilled_at (Step 5/6 = email sent, often a day later).
    shipped_at         = coalesce(new.label_confirmed_at, new.fulfilled_at, now())
   where serial = new.assigned_serial;

  return new;
end;
$$;

-- ============================================================================
-- 2. Back-fill historical shipped_at from notes
-- ============================================================================
update public.units
   set shipped_at = (substring(notes from '\d{4}-\d{2}-\d{2}') || ' 12:00:00+00')::timestamptz
 where status = 'shipped'
   and notes ~ '\d{4}-\d{2}-\d{2}';

-- Also back-fill app-driven shipments where the queue row is at step 6 but
-- the trigger set shipped_at to fulfilled_at instead of label_confirmed_at.
-- (Only matters for rows fulfilled before this trigger update.)
update public.units u
   set shipped_at = q.label_confirmed_at
  from public.fulfillment_queue q
 where q.step = 6
   and q.assigned_serial = u.serial
   and q.label_confirmed_at is not null
   and (u.shipped_at is null or u.shipped_at <> q.label_confirmed_at);
