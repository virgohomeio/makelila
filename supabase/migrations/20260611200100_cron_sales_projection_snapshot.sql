DO $$ BEGIN
  PERFORM cron.unschedule('sales-projection-snapshot');
EXCEPTION WHEN others THEN NULL; END $$;

SELECT cron.schedule(
  'sales-projection-snapshot',
  '45 7 * * *',   -- 07:45 UTC = 02:45 ET
  $$
    SELECT net.http_post(
      url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'supabase_url') || '/functions/v1/sales-projection-snapshot',
      headers := jsonb_build_object('Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_secret')),
      body := '{}'::jsonb
    );
  $$
);
