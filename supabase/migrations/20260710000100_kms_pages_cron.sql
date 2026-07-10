-- Schedule Notion KMS metadata sync every 6 hours.
-- Uses invoke_edge_function() which sends both Authorization and X-Cron-Secret headers.

do $$
begin
  if exists (select 1 from cron.job where jobname = 'sync-notion-kms-every-6h') then
    perform cron.unschedule('sync-notion-kms-every-6h');
  end if;
end $$;

select cron.schedule(
  'sync-notion-kms-every-6h',
  '0 */6 * * *',   -- 00:00, 06:00, 12:00, 18:00 UTC
  $$ select public.invoke_edge_function('sync-notion-kms-metadata'); $$
);
