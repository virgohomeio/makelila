-- Runs purge-stale-candidates once daily. Same invoke_edge_function()
-- helper as every other cron job in this repo (patches in both
-- Authorization and X-Cron-Secret headers).

select cron.schedule(
  'purge-stale-candidates-daily',
  '0 3 * * *',   -- 03:00 UTC daily, off-peak
  $$ select public.invoke_edge_function('purge-stale-candidates'); $$
);
