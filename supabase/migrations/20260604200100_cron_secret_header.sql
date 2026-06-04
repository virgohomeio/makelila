-- Security pass Phase 3a (spec: docs/superpowers/specs/2026-06-03-security-pass-design.md).
-- Update the pg_cron → edge function bridge to send X-Cron-Secret. Reads
-- the secret from the Postgres GUC `app.cron_shared_secret` (set via
-- `alter database postgres set app.cron_shared_secret = '...'`).
-- The matching Supabase secret CRON_SHARED_SECRET is what each edge
-- function compares against in Phase 3b's authenticate() wrapper.

create or replace function public.invoke_edge_function(
  fn_name text,
  body jsonb default '{}'::jsonb
)
returns void language plpgsql security definer as $$
declare
  base_url text := coalesce(
    current_setting('app.supabase_url', true),
    'https://txeftbbzeflequvrmjjr.supabase.co'
  );
  anon_key text := coalesce(
    current_setting('app.supabase_anon_key', true),
    -- Baked-in fallback (matches the existing migration 20260512130000).
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR4ZWZ0YmJ6ZWZsZXF1dnJtampyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYyNzk3NjcsImV4cCI6MjA5MTg1NTc2N30.sWmDCODRuhutbHuXcoVIVRvVvVyZADpNysFkerOXNPw'
  );
  cron_secret text := coalesce(current_setting('app.cron_shared_secret', true), '');
begin
  perform net.http_post(
    url := base_url || '/functions/v1/' || fn_name,
    headers := jsonb_build_object(
      'Content-Type',   'application/json',
      'Authorization',  'Bearer ' || anon_key,
      'X-Cron-Secret',  cron_secret
    ),
    body := body
  );
end $$;
