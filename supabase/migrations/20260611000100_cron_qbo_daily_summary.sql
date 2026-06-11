-- Finance module: pg_cron job for the qbo-daily-summary edge function.
-- See docs/session-notes/huayi.md §Feature 5.
--
-- Runs at 07:00 UTC every day = 02:00 America/Toronto (EST+5 / EDT+4).
-- 02:00 ET is well past Shopify's end-of-day settlement window in both
-- summer and winter, so the prior day's transactions are complete.
--
-- The edge function receives a CRON-only request authenticated by the
-- shared secret in app.cron_shared_secret (set via supabase secrets).
-- It uses its own service_role key to read orders/refunds and write
-- qbo_daily_journals, then calls the QBO Accounting API.
--
-- Idempotent: unschedule ignores "job not found" via the EXCEPTION block,
-- then schedule re-creates it fresh.

DO $$
BEGIN
  PERFORM cron.unschedule('qbo-daily-summary');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

SELECT cron.schedule(
  'qbo-daily-summary',
  '0 7 * * *',
  $$
    SELECT net.http_post(
      url     := current_setting('app.supabase_url') || '/functions/v1/qbo-daily-summary',
      headers := jsonb_build_object(
        'Content-Type',    'application/json',
        'x-cron-secret',   current_setting('app.cron_shared_secret')
      ),
      body    := '{}'::jsonb
    )
  $$
);
