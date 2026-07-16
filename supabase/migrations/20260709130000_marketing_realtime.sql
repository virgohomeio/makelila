-- Add the marketing tables to the realtime publication so the Marketing
-- module auto-refreshes when a sync writes new rows (no manual page reload).
--
-- Guarded on table existence: fb_campaigns and klaviyo_sync_log were created
-- directly in the dashboard (no migration), so a fresh local db may not have
-- them yet.

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'fb_campaigns',
    'fb_ads',
    'ga4_daily',
    'gsc_daily',
    'klaviyo_sync_log',
    'social_metrics'
  ] LOOP
    IF to_regclass('public.' || t) IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = t
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
    END IF;
  END LOOP;
END $$;
