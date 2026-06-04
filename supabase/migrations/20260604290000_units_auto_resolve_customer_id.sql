-- Backlog #67 follow-up: trigger that auto-resolves units.customer_id from
-- units.customer_name on every INSERT/UPDATE. Means all write sites
-- (Order Review's serial-pick, createReplacementOrder, Stock manual edit,
-- fulfillment-flag sync) get the canonical FK for free without touching
-- the JS write paths.
--
-- Behavior:
--   - Trigger only fires when customer_id is NULL on the new row and
--     customer_name is non-null. If the caller is explicitly setting
--     customer_id (e.g. from a picker), the trigger leaves it alone.
--   - Resolution uses the same cascade as customerForSerial(): exact match
--     on full_name, then last_name + first_name-starts-with, with a
--     parenthetical-strip pass for "(test)" / "(original)" suffixes.
--   - If >1 candidate matches at any step, the function returns NULL
--     rather than picking the wrong customer.

create or replace function public.resolve_customer_id_from_name(p_name text)
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_name      text := trim(coalesce(p_name, ''));
  v_clean     text := trim(regexp_replace(coalesce(p_name, ''), '\s*\([^)]*\)\s*', ' ', 'g'));
  v_first     text;
  v_last      text;
  v_clean_first text;
  v_clean_last  text;
  v_result    uuid;
  v_count     int;
begin
  if v_name = '' then return null; end if;

  -- 1. Exact full_name match on raw name
  select id, count(*) over () into v_result, v_count
    from public.customers where lower(full_name) = lower(v_name)
    limit 1;
  if v_count = 1 then return v_result; end if;

  -- 2. Token cascade on raw name
  if array_length(regexp_split_to_array(v_name, '\s+'), 1) >= 2 then
    v_first := split_part(v_name, ' ', 1);
    v_last  := split_part(v_name, ' ', array_length(regexp_split_to_array(v_name, '\s+'), 1));
    select id, count(*) over () into v_result, v_count
      from public.customers
     where lower(last_name) = lower(v_last)
       and lower(first_name) like lower(v_first) || '%'
     limit 1;
    if v_count = 1 then return v_result; end if;
  end if;

  -- 3. Exact full_name on cleaned name (strip parentheticals)
  if v_clean <> v_name and v_clean <> '' then
    select id, count(*) over () into v_result, v_count
      from public.customers where lower(full_name) = lower(v_clean)
      limit 1;
    if v_count = 1 then return v_result; end if;

    -- 4. Token cascade on cleaned name
    if array_length(regexp_split_to_array(v_clean, '\s+'), 1) >= 2 then
      v_clean_first := split_part(v_clean, ' ', 1);
      v_clean_last  := split_part(v_clean, ' ', array_length(regexp_split_to_array(v_clean, '\s+'), 1));
      select id, count(*) over () into v_result, v_count
        from public.customers
       where lower(last_name) = lower(v_clean_last)
         and lower(first_name) like lower(v_clean_first) || '%'
       limit 1;
      if v_count = 1 then return v_result; end if;
    end if;
  end if;

  return null;
end $$;

revoke all on function public.resolve_customer_id_from_name(text) from anon, public;
grant execute on function public.resolve_customer_id_from_name(text) to authenticated;

create or replace function public.units_set_customer_id_from_name()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- Only auto-resolve when the caller didn't explicitly set customer_id
  -- AND there's a customer_name to resolve from.
  if new.customer_id is null and new.customer_name is not null then
    new.customer_id := public.resolve_customer_id_from_name(new.customer_name);
  end if;
  return new;
end $$;

drop trigger if exists units_auto_customer_id on public.units;
create trigger units_auto_customer_id
before insert or update of customer_name, customer_id on public.units
for each row execute function public.units_set_customer_id_from_name();
