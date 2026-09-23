-- Freightcom rate probe — ship-date sweep + week-long drift.
-- Spec: docs/superpowers/specs/2026-09-22-freightcom-rate-probe-design.md
--
-- Rates each confirmed order against the next seven PICKUP dates, twice a day
-- for seven days. The ship-date sweep is the part that answers "cheapest date
-- to ship"; the twice-daily repeat measures rate-card drift, which is real —
-- freight_quotes already holds one order quoted six days apart at $169.24 and
-- then $180.27.
--
-- Probe rows deliberately do NOT go in freight_quotes. useFreightQuotes()
-- selects * for an order with no limit, so ~2,850 probe rows would put ~700
-- rows into each order's Sales Freight card and break it.

-- ---------------------------------------------------------------------------
-- 1. A pg_net bridge that doesn't time out at 5 seconds.
-- ---------------------------------------------------------------------------
-- public.invoke_edge_function() calls net.http_post with no
-- timeout_milliseconds, so pg_net applies its 5000 ms default —
-- 20260806150000_freightcom_sync_cron_timeout.sql is the post-mortem of what
-- that cost: every Freightcom sync run was killed at 5.001 s while
-- cron.job_run_details cheerfully reported "succeeded" for 45 consecutive runs,
-- because that view only records whether the SQL queued the request.
--
-- The probe function is chunked and returns quickly, so this timeout should
-- never be the thing that bites. It is set anyway, because the failure mode it
-- prevents is silent.
create or replace function public.invoke_edge_function_with_timeout(
  fn_name text,
  body jsonb default '{}'::jsonb,
  timeout_ms int default 30000
)
returns void language plpgsql security definer as $$
declare
  base_url text := coalesce(
    current_setting('app.supabase_url', true),
    'https://txeftbbzeflequvrmjjr.supabase.co'
  );
  anon_key text := coalesce(
    current_setting('app.supabase_anon_key', true),
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR4ZWZ0YmJ6ZWZsZXF1dnJtampyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYyNzk3NjcsImV4cCI6MjA5MTg1NTc2N30.sWmDCODRuhutbHuXcoVIVRvVvVyZADpNysFkerOXNPw'
  );
  cron_secret text := coalesce(private.get_app_secret('cron_shared_secret'), '');
begin
  perform net.http_post(
    url := base_url || '/functions/v1/' || fn_name,
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || anon_key,
      'X-Cron-Secret', cron_secret
    ),
    body := body,
    timeout_milliseconds := timeout_ms
  );
end $$;

-- SECURITY DEFINER + a fn_name parameter is a general "call any of our edge
-- functions with the cron secret" primitive, so it must not be reachable from a
-- browser session.
revoke execute on function public.invoke_edge_function_with_timeout(text, jsonb, int)
  from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Tables
-- ---------------------------------------------------------------------------

-- One row per probe campaign. `cohort` freezes the order ids at job start: the
-- Sales Confirmed tab is live, and a customer entering or leaving mid-week
-- would make the week's numbers non-comparable.
create table if not exists public.freight_rate_probe_jobs (
  id          uuid primary key default gen_random_uuid(),
  label       text        not null unique,
  started_on  date        not null default (now() at time zone 'utc')::date,
  days        int         not null default 7,
  ship_dates  int         not null default 7,   -- sweep D+1 .. D+ship_dates
  cohort      jsonb       not null,             -- [{order_id, order_ref, customer_name, postal, country}]
  status      text        not null default 'active'
                check (status in ('active', 'complete', 'aborted')),
  note        text        null,
  created_at  timestamptz not null default now()
);

-- One row per invocation cycle (twice a day). `cursor_index` is the index into the
-- cohort that the next chunk starts at, which is what makes the run resumable
-- and keeps any single invocation well inside the wall-clock limit.
create table if not exists public.freight_rate_probe_runs (
  id           uuid        primary key default gen_random_uuid(),
  job_id       uuid        not null references public.freight_rate_probe_jobs(id) on delete cascade,
  run_index    int         not null,
  day_index    int         not null,            -- 1-based day of the campaign
  started_at   timestamptz not null default now(),
  finished_at  timestamptz null,
  cursor_index int         not null default 0,
  quotes_saved int         not null default 0,
  status       text        not null default 'running'
                 check (status in ('running', 'complete', 'failed')),
  error        text        null,
  unique (job_id, run_index)
);

-- One row per rate returned, per (order, ship_date, run).
create table if not exists public.freight_rate_probes (
  id            uuid        primary key default gen_random_uuid(),
  run_id        uuid        not null references public.freight_rate_probe_runs(id) on delete cascade,
  job_id        uuid        not null references public.freight_rate_probe_jobs(id) on delete cascade,
  order_id      uuid        not null references public.orders(id) on delete cascade,
  order_ref     text        not null,
  customer_name text        not null,
  dest_postal   text        not null,
  dest_country  text        not null,
  ship_date     date        not null,
  ship_weekday  int         not null,           -- 0=Sun .. 6=Sat, for "cheapest day of week"
  run_index     int         not null,
  run_at        timestamptz not null default now(),
  carrier       text        not null default '',
  service_level text        not null,
  rate_cad      numeric(10,2) null,
  transit_days  int         null,
  package_count int         not null default 1,
  -- Set only on the cheapest CAD rate for each (order, ship_date, run), so the
  -- report can filter to decisions rather than to every carrier option.
  is_cheapest   boolean     not null default false,
  flag_level    text        not null default 'none'
                  check (flag_level in ('none', 'warn', 'critical')),
  raw           jsonb       not null
);

create index if not exists idx_frp_job_order_ship
  on public.freight_rate_probes (job_id, order_id, ship_date);
create index if not exists idx_frp_cheapest
  on public.freight_rate_probes (job_id, is_cheapest) where is_cheapest = true;
create index if not exists idx_frp_run
  on public.freight_rate_probes (run_id);

-- ---------------------------------------------------------------------------
-- 3. RLS — internal operators read; the functions write as service role.
-- ---------------------------------------------------------------------------
alter table public.freight_rate_probe_jobs enable row level security;
alter table public.freight_rate_probe_runs enable row level security;
alter table public.freight_rate_probes     enable row level security;

do $$
declare t text;
begin
  foreach t in array array['freight_rate_probe_jobs','freight_rate_probe_runs','freight_rate_probes'] loop
    if not exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = t and policyname = 'internal_only'
    ) then
      execute format(
        'create policy internal_only on public.%I using (public.is_internal_user()) with check (public.is_internal_user())',
        t
      );
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 4. Cron guard + teardown
-- ---------------------------------------------------------------------------

-- The crons below fire unconditionally; this is what makes them a no-op once
-- the campaign is over. Guarding in SQL rather than inside the edge function
-- means an expired job costs nothing at all — no invocation, no cold start.
create or replace function public.freight_probe_job_active()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.freight_rate_probe_jobs
    where status = 'active'
      and (now() at time zone 'utc')::date < started_on + days
  );
$$;

-- How the probe hands itself the next chunk.
--
-- The alternative — the isolate calling its own URL and holding the promise
-- open — keeps one isolate alive for the whole run and puts us straight back
-- under the wall-clock limit that chunking exists to avoid. pg_net dispatches
-- from a background worker instead, so the current invocation can return the
-- moment it has queued the next one.
create or replace function public.freight_probe_next_chunk()
returns void language sql security definer set search_path = public as $$
  select public.invoke_edge_function_with_timeout(
    'freightcom-rate-probe', '{"source":"chunk"}'::jsonb, 30000
  );
$$;

revoke execute on function public.freight_probe_next_chunk() from anon, authenticated;
grant  execute on function public.freight_probe_next_chunk() to service_role;

-- Called by the report function on the final day: closes the campaign and
-- removes both schedules, so the job cleans up after itself.
create or replace function public.freight_probe_finish(job uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.freight_rate_probe_jobs set status = 'complete' where id = job;

  if exists (select 1 from cron.job where jobname = 'freightcom-rate-probe') then
    perform cron.unschedule('freightcom-rate-probe');
  end if;
  if exists (select 1 from cron.job where jobname = 'freight-rate-report') then
    perform cron.unschedule('freight-rate-report');
  end if;
end $$;

revoke execute on function public.freight_probe_finish(uuid) from anon, authenticated;
grant  execute on function public.freight_probe_finish(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 5. Schedules
-- ---------------------------------------------------------------------------
-- 12:00 and 00:00 UTC = 08:00 and 20:00 ET. The `where` clause is the guard:
-- no active job means no row, which means net.http_post is never called.
do $$ begin
  if exists (select 1 from cron.job where jobname = 'freightcom-rate-probe') then
    perform cron.unschedule('freightcom-rate-probe');
  end if;
  if exists (select 1 from cron.job where jobname = 'freight-rate-report') then
    perform cron.unschedule('freight-rate-report');
  end if;
end $$;

select cron.schedule(
  'freightcom-rate-probe',
  '0 12,0 * * *',
  $CRON$
  select public.invoke_edge_function_with_timeout('freightcom-rate-probe', '{"source":"cron"}'::jsonb, 30000)
  where public.freight_probe_job_active();
  $CRON$
);

-- Daily at 13:00 UTC (~09:00 ET). The function itself decides whether today is
-- day 2, 4 or 7 of the campaign and stays silent otherwise, so the schedule
-- carries no date arithmetic.
select cron.schedule(
  'freight-rate-report',
  '0 13 * * *',
  $CRON$
  select public.invoke_edge_function_with_timeout('freight-rate-report', '{"source":"cron"}'::jsonb, 60000)
  where public.freight_probe_job_active();
  $CRON$
);

-- New tables are invisible to PostgREST until its schema cache reloads, and
-- both edge functions reach the database through it. Without this the probe's
-- first run would fail with PGRST205 "could not find the table" — which reads
-- like the migration never ran, rather than like a stale cache.
notify pgrst, 'reload schema';

comment on table public.freight_rate_probes is
  'Freightcom rate samples: one row per carrier rate per (order, pickup date, run). Separate from freight_quotes on purpose — the Sales Freight card reads that table unbounded.';
