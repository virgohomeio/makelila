-- Customer serial numbers, sourced from the "LILA customer fulfillment.xlsx"
-- sheet (via public.fulfillment_log). THE SHEET IS THE SOURCE OF TRUTH for this
-- column: every sync clears and re-populates it, so removing a serial from the
-- sheet removes it here. This is an explicit, documented exception to the usual
-- insert-only/operator-curated rule (CLAUDE.md → System of record), requested
-- because the fulfillment sheet is the authoritative record of which serial
-- shipped to which customer.

alter table public.customers
  add column if not exists serials text[],
  add column if not exists serials_synced_at timestamptz;

comment on column public.customers.serials is
  'Unit serial numbers owned by this customer, per the fulfillment sheet. Source of truth = the sheet; overwritten by public.sync_customer_serials_from_fulfillment().';

-- Derive customers.serials from fulfillment_log.
--   Match each sheet serial to a customer by EMAIL first (case-insensitive),
--   falling back to FULL NAME when the row has no email match.
--   Returns a report: how many customers were updated + the unmatched rows.
create or replace function public.sync_customer_serials_from_fulfillment()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_updated int := 0;
  v_unmatched jsonb;
begin
  -- Resolve every distinct sheet serial to a customer id (or null = unmatched).
  drop table if exists _serial_resolved;
  create temp table _serial_resolved as
    with src as (
      -- Only real unit serials (LL01-NNNN). Normalizes trailing junk like
      -- 'LL01-00000000307 (?)' and ignores non-serials ('Posters', notes, etc).
      select distinct
        substring(serial_number from 'LL01-[0-9]+')  as serial,
        lower(nullif(trim(email), ''))               as email_key,
        lower(nullif(trim(customer_name), ''))       as name_key
      from public.fulfillment_log
      where serial_number ~ 'LL01-[0-9]+'
    )
    select
      s.serial,
      s.email_key,
      s.name_key,
      coalesce(
        (select c.id from public.customers c
           where s.email_key is not null and lower(c.email) = s.email_key
           order by c.created_at limit 1),
        (select c.id from public.customers c
           where s.name_key is not null and lower(c.full_name) = s.name_key
           order by c.created_at limit 1)
      ) as customer_id
    from src s;

  -- Sheet wins: clear all previously-synced serials, then set fresh.
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

  select coalesce(jsonb_agg(jsonb_build_object(
           'serial', serial, 'email', email_key, 'name', name_key)), '[]'::jsonb)
    into v_unmatched
    from _serial_resolved
    where customer_id is null;

  drop table if exists _serial_resolved;

  return jsonb_build_object(
    'customers_updated', v_updated,
    'unmatched_count', jsonb_array_length(v_unmatched),
    'unmatched', v_unmatched
  );
end;
$$;
