-- Sweep pending orders for customer-communication signals every 15 minutes.
-- Spec: docs/superpowers/specs/2026-09-10-order-communication-indicator-design.md
--
-- 15 minutes rather than the 5 the sync functions use: this one only has
-- something to do once a sync has actually landed new messages, and an
-- unchanged conversation short-circuits on its fingerprint before any model is
-- called. Operators who need an answer sooner press Re-check on the card.
--
-- Deliberately NOT public.invoke_edge_function(): that helper calls
-- net.http_post without timeout_milliseconds, so it takes pg_net's 5-second
-- default. Five seconds does not cover a sweep that makes model calls. The
-- call is spelled out here with a real timeout, the same way
-- sync-freightcom-shipments-daily does.

select cron.unschedule('assess-order-communication-15min')
where exists (select 1 from cron.job where jobname = 'assess-order-communication-15min');

select cron.schedule(
  'assess-order-communication-15min',
  '7,22,37,52 * * * *',
  $cron$
  select net.http_post(
    url := 'https://txeftbbzeflequvrmjjr.supabase.co/functions/v1/assess-order-communication',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      -- Same fallback chain as public.invoke_edge_function: the GUC is unset on
      -- this project, so the literal is what actually gets used.
      'Authorization', 'Bearer ' || coalesce(
        current_setting('app.supabase_anon_key', true),
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR4ZWZ0YmJ6ZWZsZXF1dnJtampyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYyNzk3NjcsImV4cCI6MjA5MTg1NTc2N30.sWmDCODRuhutbHuXcoVIVRvVvVyZADpNysFkerOXNPw'
      ),
      'X-Cron-Secret', coalesce(private.get_app_secret('cron_shared_secret'), '')
    ),
    body := '{"scope":"pending"}'::jsonb,
    timeout_milliseconds := 240000
  );
  $cron$
);
