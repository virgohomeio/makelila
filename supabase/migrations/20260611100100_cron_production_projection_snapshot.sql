DO $$ BEGIN
  PERFORM cron.unschedule('production-projection-snapshot');
EXCEPTION WHEN others THEN NULL; END $$;

SELECT cron.schedule(
  'production-projection-snapshot',
  '30 7 * * *',   -- 07:30 UTC = 02:30 ET
  $$
    SELECT net.http_post(
      url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'supabase_url') || '/functions/v1/production-projection-snapshot',
      headers := jsonb_build_object('Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_secret')),
      body := '{}'::jsonb
    );
  $$
);
