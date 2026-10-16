-- Cron invoker used net.http_post's default 5s timeout. pg_net closes the
-- connection at that point, which aborts the edge function mid-run. The
-- Meta ad-level pull (sync-facebook-ads) takes ~90-120s, so it was being
-- killed every cron run — campaigns (fast) synced, fb_ads (slow) went stale.
-- Bump the wait to 180s so slow syncs run to completion. pg_net is async
-- (background worker), so a longer wait does not block anything.
CREATE OR REPLACE FUNCTION public.invoke_edge_function(fn_name text, body jsonb DEFAULT '{}'::jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  base_url text := coalesce(
    current_setting('app.supabase_url', true),
    'https://txeftbbzeflequvrmjjr.supabase.co'
  );
  anon_key text := coalesce(
    current_setting('app.supabase_anon_key', true),
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR4ZWZ0YmJ6ZWZsZXF1dnJtampyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYyNzk3NjcsImV4cCI6MjA5MTg1NTc2N30.sWmDCODRuhutbHuXcoVIVRvVvVyZADpNysFkerOXNPw'
  );
  cron_secret text := coalesce(private.get_app_secret('cron_shared_secret'), '');
begin
  perform net.http_post(
    url := base_url || '/functions/v1/' || fn_name,
    headers := jsonb_build_object(
      'Content-Type',   'application/json',
      'Authorization',  'Bearer ' || anon_key,
      'X-Cron-Secret',  cron_secret
    ),
    body := body,
    timeout_milliseconds := 180000
  );
end $function$;
