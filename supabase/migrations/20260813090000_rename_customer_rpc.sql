-- Customer name editing, propagated everywhere.
-- Spec: docs/superpowers/specs/2026-08-13-customer-name-editing-design.md
--
-- customers.full_name is a generated column, so correcting first_name /
-- last_name fixes every screen that reads the customers row. What it does NOT
-- fix is the eleven tables holding a denormalized customer_name snapshot —
-- and several of those are matched back to the customer BY that string
-- (followupStatus name keys, units -> customer resolution, purchaser export).
-- A rename that skips them doesn't just leave stale text on screen, it
-- orphans the record.
--
-- This function does the rename and every cascade in one transaction. Pass
-- p_dry_run := true to get the same row counts with nothing written — the
-- predicate is built once per table and shared by both branches, so the
-- preview the operator confirms cannot disagree with what gets applied.

create or replace function public.rename_customer(
  p_customer_id uuid,
  p_first_name  text,
  p_last_name   text,
  p_dry_run     boolean default false
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_cust        public.customers%rowtype;
  v_old_name    text;
  v_new_name    text;
  v_email       text;
  v_ambiguous   boolean := false;
  v_updated     jsonb := '{}'::jsonb;
  v_skipped     jsonb := '[]'::jsonb;
  cfg           record;
  v_keys        text[];
  v_name_cond   text;
  v_pred        text;
  v_label       text;
  v_count       integer;
  v_rows        jsonb;
begin
  select * into v_cust from public.customers where id = p_customer_id;
  if not found then
    raise exception 'Customer % not found.', p_customer_id;
  end if;

  v_old_name := trim(coalesce(v_cust.full_name, ''));
  v_new_name := trim(
    coalesce(nullif(trim(p_first_name), ''), '') || ' ' ||
    coalesce(nullif(trim(p_last_name),  ''), '')
  );

  -- Emptying both fields would erase the join key the cascades below depend
  -- on, and this UI couldn't put it back.
  if v_new_name = '' then
    raise exception 'A customer needs at least a first or last name.';
  end if;

  v_email := nullif(lower(trim(coalesce(v_cust.email, ''))), '');

  -- The old name is ambiguous when another customer answers to it. Four such
  -- pairs exist in prod today. When ambiguous we suppress name-only matching
  -- entirely and report what we left behind, rather than rewriting rows that
  -- may belong to the other person.
  if v_old_name <> '' then
    select exists (
      select 1 from public.customers c
      where c.id <> p_customer_id
        and lower(trim(coalesce(c.full_name, ''))) = lower(v_old_name)
    ) into v_ambiguous;
  end if;

  for cfg in
    select * from (values
      -- table,                   pk,       has customer_id, has customer_email, label column
      ('orders',                 'id',     true,  true,  'order_ref'),
      ('service_tickets',        'id',     true,  true,  'subject'),
      ('units',                  'serial', true,  false, null),
      ('part_shipments',         'id',     true,  false, null),
      ('returns',                'id',     false, true,  null),
      ('refund_approvals',       'id',     false, true,  null),
      ('replacement_queue',      'id',     false, true,  null),
      ('order_cancellations',    'id',     false, true,  null),
      ('shipping_damage_claims', 'id',     false, true,  null),
      ('fulfillment_log',        'id',     false, false, null)
    ) as t(tbl, pk, has_cid, has_email, label)
  loop
    -- Matching ladder, in priority order and exclusive: an explicit FK to
    -- someone else outranks a weaker key pointing here, so each weaker branch
    -- only considers rows the stronger keys left unclaimed.
    v_keys := array[]::text[];

    if cfg.has_cid then
      v_keys := v_keys || format('customer_id = %L', p_customer_id);
    end if;

    if cfg.has_email and v_email is not null then
      v_keys := v_keys || (
        case when cfg.has_cid
          then format('(customer_id is null and lower(trim(customer_email)) = %L)', v_email)
          else format('lower(trim(customer_email)) = %L', v_email)
        end
      );
    end if;

    -- Name fallback: only rows no stronger key claimed, and only when the old
    -- name is unambiguous.
    v_name_cond := null;
    if v_old_name <> '' then
      v_name_cond := format('lower(trim(coalesce(customer_name, ''''))) = %L', lower(v_old_name));
      if cfg.has_email then
        v_name_cond := 'coalesce(trim(customer_email), '''') = '''' and ' || v_name_cond;
      end if;
      if cfg.has_cid then
        v_name_cond := 'customer_id is null and ' || v_name_cond;
      end if;
      v_name_cond := '(' || v_name_cond || ')';

      if not v_ambiguous then
        v_keys := v_keys || v_name_cond;
      end if;
    end if;

    -- Rows already carrying the corrected name aren't changes; excluding them
    -- from the predicate keeps the preview counts honest.
    if array_length(v_keys, 1) > 0 then
      v_pred := '(' || array_to_string(v_keys, ' or ') || ')'
                || format(' and coalesce(customer_name, '''') <> %L', v_new_name);

      if p_dry_run then
        execute format('select count(*) from public.%I where %s', cfg.tbl, v_pred)
          into v_count;
      else
        execute format('update public.%I set customer_name = %L where %s',
                       cfg.tbl, v_new_name, v_pred);
        get diagnostics v_count = row_count;
      end if;

      if v_count > 0 then
        v_updated := v_updated || jsonb_build_object(cfg.tbl, v_count);
      end if;
    end if;

    -- What the ambiguity rule cost us, so the operator can fix those by hand.
    if v_ambiguous and v_name_cond is not null then
      v_label := case when cfg.label is null
                   then 'null::text'
                   else format('%I::text', cfg.label)
                 end;
      execute format(
        'select coalesce(jsonb_agg(jsonb_build_object('
        || '''table'', %L, ''id'', %I::text, ''label'', %s)), ''[]''::jsonb) '
        || 'from public.%I where %s and coalesce(customer_name, '''') <> %L',
        cfg.tbl, cfg.pk, v_label, cfg.tbl, v_name_cond, v_new_name
      ) into v_rows;
      v_skipped := v_skipped || v_rows;
    end if;
  end loop;

  -- The rename itself goes last: a failure in any cascade above aborts the
  -- whole transaction rather than leaving the customer renamed with stale
  -- copies behind.
  if not p_dry_run then
    update public.customers
       set first_name = nullif(trim(p_first_name), ''),
           last_name  = nullif(trim(p_last_name),  '')
     where id = p_customer_id;
  end if;

  return jsonb_build_object(
    'old_name',  v_old_name,
    'new_name',  v_new_name,
    'ambiguous', v_ambiguous,
    'updated',   v_updated,
    'skipped',   v_skipped
  );
end $$;

comment on function public.rename_customer(uuid, text, text, boolean) is
  'Correct a customer''s first/last name and propagate the new name to every '
  'denormalized customer_name snapshot. Rows matchable only by a name shared '
  'with another customer are skipped and reported. p_dry_run returns the same '
  'counts without writing. Spec: docs/superpowers/specs/2026-08-13-customer-name-editing-design.md';

grant execute on function public.rename_customer(uuid, text, text, boolean) to authenticated;
