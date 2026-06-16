-- Backlog #32 — tighten Calendly sync from hourly to every 5 minutes.
-- New bookings were showing up in makeLILA with up to ~60 min delay;
-- the Gmail and Quo syncs already run every 5 minutes. Aligning cadence.
do $outer$
begin
  if exists (select 1 from cron.job where jobname = 'sync-calendly-hourly') then
    perform cron.unschedule('sync-calendly-hourly');
  end if;
  if exists (select 1 from cron.job where jobname = 'sync-calendly-5min') then
    perform cron.unschedule('sync-calendly-5min');
  end if;
  perform cron.schedule(
    'sync-calendly-5min',
    '*/5 * * * *',
    $$ select public.invoke_edge_function('sync-calendly-events'); $$
  );
end;
$outer$;
