-- Make every fulfillment-sheet serial show its customer on the Dashboard.
--
-- The Dashboard resolves a machine's display name from units.customer_name
-- (lib/dashboard.ts → useUnitCustomerMap). The sheet sync
-- (sync_customer_serials_from_fulfillment) already resolves each sheet serial
-- to a customer for the customers.serials[] array, but it never wrote that
-- resolution back to the units table — so a serial that shipped per the sheet
-- but whose units row had a NULL customer_name still rendered as a raw
-- "LL01-…" on the Dashboard.
--
-- This redefines the RPC to ALSO write the resolved customer into
--   units.customer_id   (the canonical FK, backlog #67), and
--   units.customer_name (denormalized display cache the Dashboard reads)
-- for every sheet serial.
--
-- Conflict policy = insert-only (CLAUDE.md → System of record default): the
-- write-back only fills NULLs, so an operator-assigned (Dashboard
-- AssignCustomerModal) or fulfillment-trigger-curated (sync_unit_on_fulfillment)
-- value is never clobbered. When a serial matches a real customer we prefer
-- that customer's canonical full_name; otherwise we fall back to the sheet's
-- raw customer_name so even an unmatched sheet serial still shows who it
-- shipped to.
--
-- customers.serials[] behaviour is unchanged (the sheet still wins — clear +
-- repopulate). The resolution CTE is restructured to one row per serial
-- (distinct on) so the units write-back can't double-update a serial that
-- appears on multiple sheet rows.

create or replace function public.sync_customer_serials_from_fulfillment()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_updated int := 0;
  v_units_updated int := 0;
  v_unmatched jsonb;
begin
  -- Resolve every distinct sheet serial to a customer id (or null = unmatched).
  drop table if exists _serial_resolved;
  create temp table _serial_resolved as
    with src as (
      -- Only real unit serials (LL01-NNNN). Normalizes trailing junk like
      -- 'LL01-00000000307 (?)' and ignores non-serials ('Posters', notes, etc).
      select
        substring(serial_number from 'LL01-[0-9]+')  as serial,
        lower(nullif(trim(email), ''))               as email_key,
        lower(nullif(trim(customer_name), ''))       as name_key,
        nullif(trim(customer_name), '')              as name_display
      from public.fulfillment_log
      where serial_number ~ 'LL01-[0-9]+'
    ),
    -- Collapse to ONE row per serial. Prefer a sheet row that carries an
    -- email, then one that carries a name, so resolution is deterministic
    -- and the units write-back updates each serial exactly once.
    dedup as (
      select distinct on (serial)
        serial, email_key, name_key, name_display
      from src
      order by serial, (email_key is null), (name_key is null)
    )
    select
      d.serial,
      d.email_key,
      d.name_key,
      d.name_display,
      coalesce(
        (select c.id from public.customers c
           where d.email_key is not null and lower(c.email) = d.email_key
           order by c.created_at limit 1),
        (select c.id from public.customers c
           where d.name_key is not null and lower(c.full_name) = d.name_key
           order by c.created_at limit 1)
      ) as customer_id
    from dedup d;

  -- ── customers.serials[] (unchanged: sheet is the source of truth) ──────────
  update public.customers set serials = null where serials is not null;

  with agg as (
    select customer_id, array_agg(distinct serial order by serial) as serials
    from _serial_resolved
    where customer_id is not null
    group by customer_id
  )
  update public.customers c
    set serials = a.serials, serials_synced_at = now()
    from agg a
    where a.customer_id = c.id;
  get diagnostics v_updated = row_count;

  -- ── units write-back (new) — fills NULLs only, never clobbers ──────────────
  -- so the Dashboard (units.customer_name) shows a customer for every serial
  -- the sheet says shipped.
  update public.units u
    set
      customer_id   = coalesce(u.customer_id, r.customer_id),
      customer_name = coalesce(u.customer_name, cust.full_name, r.name_display)
    from _serial_resolved r
    left join public.customers cust on cust.id = r.customer_id
    where u.serial = r.serial
      and u.is_team_test = false
      and (
        (u.customer_id   is null and r.customer_id is not null)
        or
        (u.customer_name is null and coalesce(cust.full_name, r.name_display) is not null)
      );
  get diagnostics v_units_updated = row_count;

  select coalesce(jsonb_agg(jsonb_build_object(
           'serial', serial, 'email', email_key, 'name', name_key)), '[]'::jsonb)
    into v_unmatched
    from _serial_resolved
    where customer_id is null;

  drop table if exists _serial_resolved;

  return jsonb_build_object(
    'customers_updated', v_updated,
    'units_updated', v_units_updated,
    'unmatched_count', jsonb_array_length(v_unmatched),
    'unmatched', v_unmatched
  );
end;
$$;

-- Run once now to backfill current data (fills the serials currently rendering
-- as raw LL01-… on the Dashboard, plus any missing canonical customer_id FKs).
select public.sync_customer_serials_from_fulfillment();
