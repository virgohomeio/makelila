-- Lovely app damage reports → support tickets.
-- Spec: docs/superpowers/specs/2026-10-05-lovely-app-tickets-in-support-design.md
--
-- sync-lovely-tickets (edge function, cron below) inserts one service_tickets
-- row per row in the Lovely project's damage_reports. lovely_report_id is the
-- dedupe key and the link the detail panel uses to load the report's photos.

-- ============================================================ lovely_report_id

alter table public.service_tickets
  add column if not exists lovely_report_id uuid;

create unique index if not exists idx_tickets_lovely_report_id
  on public.service_tickets (lovely_report_id)
  where lovely_report_id is not null;

comment on column public.service_tickets.lovely_report_id is
  'Lovely project damage_reports.id this ticket was created from (source = lovely_app). Insert-only: the sync never updates the ticket afterwards.';

-- ============================================================ source check (extend)

-- Pattern mirrors 20260610150000_unit_telemetry_state.sql.
alter table public.service_tickets drop constraint if exists service_tickets_source_check;
alter table public.service_tickets add constraint service_tickets_source_check
  check (source = any (array[
    'calendly','customer_form','hubspot','fulfillment_flag',
    'ops_manual','gmail','quo','google_calendar','telemetry_auto',
    'lovely_app'
  ]));

-- ============================================================ sync-lovely-tickets every 15 min

do $$
begin
  if exists (select 1 from cron.job where jobname = 'sync-lovely-tickets-15min') then
    perform cron.unschedule('sync-lovely-tickets-15min');
  end if;
end $$;

-- The live invoke_edge_function() passes timeout_milliseconds := 180000, which
-- covers the first (backfill) run: two round trips per report.
select cron.schedule(
  'sync-lovely-tickets-15min',
  '*/15 * * * *',
  $$ select public.invoke_edge_function('sync-lovely-tickets'); $$
);
