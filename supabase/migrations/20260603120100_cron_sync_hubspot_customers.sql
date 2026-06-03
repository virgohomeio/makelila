-- Walkthrough #34: auto-sync HubSpot customers on a 30-minute cron so new
-- contacts (like Pedrum's secondary pedruma71@gmail.com profile) appear in
-- the makelila customer picker without an operator clicking "Sync now"
-- mid-call. 30-min interval is a compromise: HubSpot sync is a full-pull
-- (no incremental), so going faster wastes API quota; going slower leaves
-- demo-pace gaps. Operators can still hit the manual sync button for an
-- immediate refresh.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'sync-hubspot-customers-30min') then
    perform cron.unschedule('sync-hubspot-customers-30min');
  end if;
end $$;

select cron.schedule(
  'sync-hubspot-customers-30min',
  '*/30 * * * *',
  $$ select public.invoke_edge_function('sync-hubspot-customers'); $$
);
