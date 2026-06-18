-- Schedule the diagnosis-call Google Calendar sync every 30 minutes.
-- Uses public.invoke_edge_function() (migration 20260604200100) so the call
-- carries the X-Cron-Secret header that the function's authenticate() helper
-- checks against CRON_SHARED_SECRET — same pattern as the telemetry crons.

do $$
begin
  if exists (select 1 from cron.job where jobname = 'sync-google-calendar-diagnosis') then
    perform cron.unschedule('sync-google-calendar-diagnosis');
  end if;
end $$;

select cron.schedule(
  'sync-google-calendar-diagnosis',
  '*/30 * * * *',
  $$ select public.invoke_edge_function('sync-google-calendar-diagnosis'); $$
);
