-- Quo (OpenPhone) → ticket polling: 5-min cron, mirrors sync-gmail-tickets-5min.
-- Inert until OPENPHONE_API_KEY + OPENPHONE_PHONE_NUMBER_IDS are set on the
-- project. Edge function gracefully no-ops when secrets are missing.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'sync-quo-tickets-5min') then
    perform cron.unschedule('sync-quo-tickets-5min');
  end if;
end $$;

select cron.schedule(
  'sync-quo-tickets-5min',
  '*/5 * * * *',
  $$ select public.invoke_edge_function('sync-quo-tickets'); $$
);
