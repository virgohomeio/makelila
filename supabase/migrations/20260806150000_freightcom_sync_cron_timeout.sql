-- Freightcom shipment sync — give the daily cron a workable HTTP timeout.
--
-- `public.invoke_edge_function()` calls net.http_post without a
-- timeout_milliseconds, so pg_net applies its 5000 ms default. The Freightcom
-- sync walks every discovered shipment (a GET per shipment, plus a 2s retry on
-- 202s) and cannot finish in 5 seconds, so every scheduled run was recorded in
-- net._http_response as `timed_out = true` with the connection dropped:
--
--   Timeout of 5000 ms reached. Total time: 5001.680000 ms
--
-- cron.job_run_details still showed "succeeded" for all 45 runs, because that
-- only reports whether the SQL queued the request — not what happened to it.
-- That is why nothing looked broken while the dashboard sat 6 weeks stale.
--
-- Note this was NOT the only fault: the finance API was also rejecting our
-- credentials (403/401), which the function swallowed as "0 invoices". That is
-- an environment/credential fix (FREIGHTCOM_BASE_URL is unset, so this sync
-- talks to the live host while freightcom-book/-invoices/-status/-tracking all
-- default to the ssd-test sandbox). This migration only removes the timeout so
-- that, once the credentials are right, the job can actually run to completion.

do $$
begin
  if exists (select 1 from cron.job where jobname = 'sync-freightcom-shipments-daily') then
    perform cron.unschedule('sync-freightcom-shipments-daily');
  end if;
end $$;

select cron.schedule(
  'sync-freightcom-shipments-daily',
  '0 3 * * *',
  $CRON$
  select net.http_post(
    url := 'https://txeftbbzeflequvrmjjr.supabase.co/functions/v1/sync-freightcom-shipments',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || coalesce(
        current_setting('app.supabase_anon_key', true),
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR4ZWZ0YmJ6ZWZsZXF1dnJtampyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYyNzk3NjcsImV4cCI6MjA5MTg1NTc2N30.sWmDCODRuhutbHuXcoVIVRvVvVyZADpNysFkerOXNPw'
      )
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 240000
  );
  $CRON$
);
