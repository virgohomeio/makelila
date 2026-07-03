-- Fulfillment → auto-verification loop.
-- Spec: docs/superpowers/specs/2026-07-03-fulfillment-auto-verification-loop-design.md
--
-- The Lovely app auto-verifies a signup when email + serial match
-- customers.serials[]. Until now that column was populated ONLY from the
-- fulfillment sheet (fulfillment_log), so wizard-shipped units never made
-- their buyers auto-verifiable. This migration makes customers.serials the
-- union of three sources and keeps it fresh in real time:
--   1. sheet-derived   (fulfillment_log, unchanged resolution logic)
--   2. wizard-derived  (fulfillment_queue step 6 → orders.customer_id)
--   3. operator adds   (customer_serial_overrides, new — Verification tab fix)
-- Clear + repopulate semantics are preserved: a serial removed from the sheet
-- disappears on re-sync unless the wizard or an override still claims it.

-- ── 1. Operator overrides: durable, audited manual serial additions ─────────
create table if not exists public.customer_serial_overrides (
  id            uuid primary key default gen_random_uuid(),
  customer_id   uuid not null references public.customers(id) on delete cascade,
  serial        text not null,
  added_by      uuid,            -- auth.uid() of the operator
  added_by_name text,
  reason        text,
  created_at    timestamptz not null default now(),
  unique (customer_id, serial)
);

comment on table public.customer_serial_overrides is
  'Operator-added serial→customer links (Verification tab fix). Insert-only; merged into customers.serials by sync_customer_serials_from_fulfillment() and add_customer_serial().';

alter table public.customer_serial_overrides enable row level security;

drop policy if exists "customer_serial_overrides_read" on public.customer_serial_overrides;
create policy "customer_serial_overrides_read" on public.customer_serial_overrides
  for select to authenticated using (public.is_internal_user());

drop policy if exists "customer_serial_overrides_insert" on public.customer_serial_overrides;
create policy "customer_serial_overrides_insert" on public.customer_serial_overrides
  for insert to authenticated with check (public.is_internal_user());

-- ── 2. Sync RPC: 3-source union ──────────────────────────────────────────────
create or replace function public.sync_customer_serials_from_fulfillment()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_updated int := 0;
  v_units_updated int := 0;
  v_wizard int := 0;
  v_overrides int := 0;
  v_unmatched jsonb;
begin
  -- security definer + returns customer PII (emails/names), so gate like
  -- add_customer_serial. Unlike that RPC, this one is also invoked directly
  -- by this migration's own backfill (final statement below), which runs as
  -- the migration role with no PostgREST request context at all — no JWT,
  -- so auth.uid() is null and is_internal_user() can't evaluate a real
  -- caller. EXECUTE is already revoked from anon/public below (only
  -- `authenticated` gets it), so any caller that reaches this point with a
  -- non-null auth.uid() came through PostgREST with a real JWT and must
  -- pass the internal-user check; a null auth.uid() means we're running
  -- outside PostgREST (migration/backfill/superuser), which is trusted by
  -- construction and skips the check.
  if auth.uid() is not null and not public.is_internal_user() then
    raise exception 'internal users only';
  end if;

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

  -- ── customers.serials[]: union of sheet + wizard + overrides ──────────────
  drop table if exists _all_serials;
  create temp table _all_serials as
    select customer_id, serial
      from _serial_resolved
     where customer_id is not null
    union
    select o.customer_id, q.assigned_serial
      from public.fulfillment_queue q
      join public.orders o on o.id = q.order_id
     where q.step = 6
       and q.assigned_serial is not null
       and o.customer_id is not null
    union
    select customer_id, serial
      from public.customer_serial_overrides;

  select count(*) into v_wizard
    from public.fulfillment_queue q
    join public.orders o on o.id = q.order_id
   where q.step = 6 and q.assigned_serial is not null and o.customer_id is not null;
  select count(*) into v_overrides from public.customer_serial_overrides;

  update public.customers set serials = null where serials is not null;

  with dedup as (
    -- Case-insensitive de-dup per customer; keep one stored casing.
    select distinct on (customer_id, upper(trim(serial)))
      customer_id, trim(serial) as serial
    from _all_serials
    order by customer_id, upper(trim(serial)), serial
  ),
  agg as (
    select customer_id, array_agg(serial order by serial) as serials
    from dedup
    group by customer_id
  )
  update public.customers c
    set serials = a.serials, serials_synced_at = now()
    from agg a
    where a.customer_id = c.id;
  get diagnostics v_updated = row_count;

  -- ── units write-back (unchanged) — fills NULLs only, never clobbers ───────
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

  -- Unmatched from BOTH sources: sheet rows that never resolved to a
  -- customer, and wizard-shipped serials whose order has no customer_id.
  -- 'source' distinguishes which pipeline produced the row.
  select coalesce(jsonb_agg(u.row), '[]'::jsonb)
    into v_unmatched
    from (
      select jsonb_build_object(
               'serial', serial, 'email', email_key, 'name', name_key, 'source', 'sheet'
             ) as row
        from _serial_resolved
       where customer_id is null
      union all
      select jsonb_build_object(
               'serial', q.assigned_serial, 'email', o.customer_email,
               'name', o.customer_name, 'source', 'wizard'
             ) as row
        from public.fulfillment_queue q
        join public.orders o on o.id = q.order_id
       where q.step = 6
         and q.assigned_serial is not null
         and o.customer_id is null
    ) u;

  drop table if exists _serial_resolved;
  drop table if exists _all_serials;

  return jsonb_build_object(
    'customers_updated', v_updated,
    'units_updated', v_units_updated,
    'wizard_serials', v_wizard,
    'override_serials', v_overrides,
    'unmatched_count', jsonb_array_length(v_unmatched),
    'unmatched', v_unmatched
  );
end;
$$;

revoke execute on function public.sync_customer_serials_from_fulfillment() from public, anon;
grant execute on function public.sync_customer_serials_from_fulfillment() to authenticated;

comment on column public.customers.serials is
  'Serials this customer can auto-verify against in the Lovely app. Union of three sources: fulfillment sheet rows (fulfillment_log), wizard step-6 fulfillments (fulfillment_queue joined to orders.customer_id), and operator overrides (customer_serial_overrides). Rebuilt wholesale by sync_customer_serials_from_fulfillment() (clear + repopulate from all three sources) and appended to in real time by the fq_append_customer_serial trigger and the add_customer_serial() RPC as wizard fulfillments and operator fixes happen.';

-- ── 3. Real-time append when a queue row reaches step 6 ─────────────────────
-- Mirrors fq_sync_unit's transition guard. The body is wrapped so a serials
-- failure can NEVER abort the step-6 update — shipping must not break
-- because of this feature (worst case the serial arrives at the next sync).
create or replace function public.append_customer_serial_on_fulfillment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_customer_id uuid;
begin
  if new.assigned_serial is null then return new; end if;
  if new.step <> 6 then return new; end if;
  if tg_op = 'UPDATE' and old.step = 6 then return new; end if;

  begin
    select customer_id into v_customer_id
      from public.orders where id = new.order_id;
    if v_customer_id is null then return new; end if;

    update public.customers c
       set serials = array_append(coalesce(c.serials, '{}'), trim(new.assigned_serial))
     where c.id = v_customer_id
       and not exists (
         select 1 from unnest(coalesce(c.serials, '{}')) s
         where upper(trim(s)) = upper(trim(new.assigned_serial))
       );
  exception when others then
    raise warning 'append_customer_serial_on_fulfillment failed for queue %: %',
      new.id, sqlerrm;
  end;
  return new;
end;
$$;

drop trigger if exists fq_append_customer_serial on public.fulfillment_queue;
create trigger fq_append_customer_serial
  after insert or update on public.fulfillment_queue
  for each row execute function public.append_customer_serial_on_fulfillment();

-- ── 4. Operator fix RPC (atomic + idempotent) ────────────────────────────────
-- security definer bypasses RLS, so gate explicitly on is_internal_user().
create or replace function public.add_customer_serial(
  p_customer_id uuid,
  p_serial      text,
  p_reason      text default null
)
returns text[]
language plpgsql
security definer
set search_path = public
as $$
declare
  v_serial text := upper(trim(p_serial));
  v_name   text;
  v_result text[];
begin
  if not public.is_internal_user() then
    raise exception 'internal users only';
  end if;
  if v_serial is null or v_serial = '' then
    raise exception 'serial must not be empty';
  end if;

  select display_name into v_name from public.profiles where id = auth.uid();

  insert into public.customer_serial_overrides
    (customer_id, serial, added_by, added_by_name, reason)
  values (p_customer_id, v_serial, auth.uid(), v_name, p_reason)
  on conflict (customer_id, serial) do nothing;

  update public.customers c
     set serials = array_append(coalesce(c.serials, '{}'), v_serial)
   where c.id = p_customer_id
     and not exists (
       select 1 from unnest(coalesce(c.serials, '{}')) s
       where upper(trim(s)) = v_serial
     );

  select serials into v_result from public.customers where id = p_customer_id;
  if not found then
    raise exception 'customer % not found', p_customer_id;
  end if;
  return v_result;
end;
$$;

revoke execute on function public.add_customer_serial(uuid, text, text) from public, anon;
grant execute on function public.add_customer_serial(uuid, text, text) to authenticated;

-- ── 5. Backfill: fold existing wizard fulfillments in now ───────────────────
select public.sync_customer_serials_from_fulfillment();
