-- units.customer_id follows the unit when it changes hands.
--
-- Bug: ST-2026-0592 — Jon Gougar's Lovely app feedback landed on Hayley
-- Halsall-Whitney's account. The ticket sync resolved serial 399 through
-- units.customer_id, and that pointed at Hayley although the unit shipped to
-- Jon on #1287.
--
-- Root cause: units_set_customer_id_from_name (20260604290000) resolves
-- customer_id only while it is NULL, taking a non-null id as "the caller set
-- this explicitly". On an UPDATE a non-null id is just as often the previous
-- holder's id carried over. No unit write in the app sets customer_id: assign,
-- flag, release, cancel, replacement, stock release, the dashboard rename and
-- the team holder all stamp customer_name / customer_order_ref only. So the
-- first customer a unit was ever stamped for kept it for good. LL01-…399:
--   #1280 Hayley (id resolved) → flagged, released (id kept) → #1295 faye gils
--   → #1287 Jon Gougar, shipped — still Hayley's.
-- The same happened to 30 other units in October, and from them to Lovely app
-- links, Lovely app events and Lovely-synced support tickets.
--
-- Fix: when the name or order changes and the write leaves customer_id as it
-- was, the id belongs to the previous holder; drop it and resolve afresh. The
-- order the unit is stamped for is now the first source, ahead of the name
-- match: it is what the unit was actually assigned to, and it resolves the
-- names the matcher can't ("Mark Marshall" for "Mark & Cheryl Marshall").
--
-- Repair: every shipped or reserved unit whose customer_id disagrees with its
-- order's customer, where the unit's customer_name agrees with that order (or
-- it has no id at all), is repointed. Units in rework, CA test or team test
-- are left for triage in Stock → Unlinked units, as in 20260902130000.
-- Everything that copied the wrong id from them is repointed too, each UPDATE
-- guarded on the wrong id still being there so an operator's correction is
-- never clobbered.
--
-- No activity_log rows, for the reason given in 20260902130000: there is no
-- authenticated actor to attribute them to. This migration is the record.

begin;

-- ---------------------------------------------------------------------------
-- 1. The trigger.
-- ---------------------------------------------------------------------------

create or replace function public.units_set_customer_id_from_name()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- New holder, untouched id: the id still names the previous holder. An id
  -- changed in the same write is the caller's (linkUnitToCustomer) and is kept.
  if tg_op = 'UPDATE'
     and new.customer_id is not distinct from old.customer_id
     and (new.customer_name is distinct from old.customer_name
          or new.customer_order_ref is distinct from old.customer_order_ref) then
    new.customer_id := null;
  end if;

  if new.customer_id is null then
    if new.customer_order_ref is not null then
      select o.customer_id into new.customer_id
        from public.orders o
       where o.order_ref = new.customer_order_ref;
    end if;
    if new.customer_id is null and new.customer_name is not null then
      new.customer_id := public.resolve_customer_id_from_name(new.customer_name);
    end if;
  end if;
  return new;
end $$;

drop trigger if exists units_auto_customer_id on public.units;
create trigger units_auto_customer_id
before insert or update of customer_name, customer_id, customer_order_ref on public.units
for each row execute function public.units_set_customer_id_from_name();

-- ---------------------------------------------------------------------------
-- 2. Units left on a previous holder.
-- ---------------------------------------------------------------------------

create temp table unit_customer_repair on commit drop as
select u.serial, u.shipped_at, u.customer_id as old_id, o.customer_id as new_id
  from public.units u
  join public.orders o on o.order_ref = u.customer_order_ref
 where u.status in ('shipped', 'reserved')
   and o.customer_id is not null
   and u.customer_id is distinct from o.customer_id
   and (u.customer_id is null
        or lower(trim(u.customer_name)) = lower(trim(o.customer_name)));

update public.units u
   set customer_id = r.new_id
  from unit_customer_repair r
 where u.serial = r.serial;

-- ---------------------------------------------------------------------------
-- 3. Lovely app accounts linked by serial to the wrong holder.
--
-- customer_app_links has no serial, so the accounts are listed: every Lovely
-- user (public.users on the Lovely project, read 2026-10-27) whose serial is in
-- the repair set and whose link resolved to that unit's old holder.
-- ingest-lovely-event would re-resolve each on its next event; this does it now.
-- ---------------------------------------------------------------------------

create temp table app_user_repair on commit drop as
select v.lovely_user_id, r.old_id, r.new_id
  from (values
    ('ce079a76-5d7d-4ac0-b194-70544aad5739'::uuid, 'LL01-00000000399'::text), -- Jon Gougar
    ('083a2939-521a-41ee-a133-ab9fd5982bc2',       'LL01-00000000408'),       -- faye gils
    ('20ab5f07-963f-4043-b7ff-5ca5b2cac0b0',       'LL01-00000000378'),       -- Raymond Keetch
    ('e556e6f3-fa85-4721-8ebf-0de05c453a44',       'LL01-00000000377')        -- Julia De Cillis
  ) as v(lovely_user_id, serial)
  join unit_customer_repair r on r.serial = v.serial;

update public.customer_app_links l
   set customer_id = a.new_id
  from app_user_repair a
 where l.lovely_user_id = a.lovely_user_id
   and l.resolution = 'serial'
   and l.customer_id is not distinct from a.old_id;

update public.customer_events e
   set customer_id = a.new_id
  from app_user_repair a
 where e.lovely_user_id = a.lovely_user_id
   and e.customer_id is not distinct from a.old_id;

-- ---------------------------------------------------------------------------
-- 4. Lovely-synced tickets filed on a repaired unit after it shipped to its
--    current holder, so filed by that holder. sync-lovely-tickets is
--    insert-only and will not revisit them. (ST-2026-0592, -0589, -0578.)
-- ---------------------------------------------------------------------------

update public.service_tickets t
   set customer_id    = r.new_id,
       customer_name  = c.full_name,
       customer_email = c.email
  from unit_customer_repair r
  join public.customers c on c.id = r.new_id
 where t.unit_serial = r.serial
   and t.source = 'lovely_app'
   and t.created_at >= r.shipped_at
   and t.customer_id is not distinct from r.old_id;

-- ---------------------------------------------------------------------------
-- 5. Assert the outcome. Fail loudly rather than half-apply.
-- ---------------------------------------------------------------------------

do $$
declare
  remaining int;
begin
  select count(*) into remaining
    from public.units u
    join public.orders o on o.order_ref = u.customer_order_ref
   where u.status in ('shipped', 'reserved')
     and o.customer_id is not null
     and u.customer_id is distinct from o.customer_id
     and (u.customer_id is null
          or lower(trim(u.customer_name)) = lower(trim(o.customer_name)));

  if remaining <> 0 then
    raise exception
      'units still disagree with their order''s customer after the repair: %. No changes committed.',
      remaining;
  end if;
end $$;

commit;
