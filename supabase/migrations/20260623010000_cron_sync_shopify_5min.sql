select cron.schedule(
  'sync-shopify-orders-5min',
  '*/5 * * * *',
  $q$select public.invoke_edge_function('sync-shopify-orders', '{"incremental":true}')$q$
);
