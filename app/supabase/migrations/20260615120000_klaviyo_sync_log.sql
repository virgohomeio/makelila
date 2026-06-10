-- Klaviyo profile sync audit log.
CREATE TABLE klaviyo_sync_log (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  synced_at    timestamptz NOT NULL DEFAULT now(),
  profiles_sent int        NOT NULL DEFAULT 0,
  errors       int         NOT NULL DEFAULT 0,
  detail       text        NULL
);

-- Keep only the last 90 runs.
CREATE INDEX idx_klaviyo_sync_log_date ON klaviyo_sync_log(synced_at DESC);

-- Add Klaviyo profile ID to customers so we can upsert by known profile.
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS klaviyo_profile_id text NULL;

-- Daily sync at 2 AM UTC via pg_cron.
-- Wrapped in a DO block so the migration succeeds even if pg_cron / net
-- extensions are not yet enabled on this Supabase project.
DO $$
BEGIN
  PERFORM cron.schedule(
    'sync-klaviyo-profiles-daily',
    '0 2 * * *',
    $$
      SELECT net.http_post(
        url    := current_setting('app.supabase_url') || '/functions/v1/sync-klaviyo-profiles',
        headers := jsonb_build_object(
          'Authorization', 'Bearer ' || current_setting('app.service_role_key'),
          'Content-Type', 'application/json'
        ),
        body   := '{}'::jsonb
      );
    $$
  );
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron not available — skipping cron schedule: %', SQLERRM;
END;
$$;
