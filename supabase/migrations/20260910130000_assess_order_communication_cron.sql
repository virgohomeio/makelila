-- Sweep pending orders for customer-communication signals every 15 minutes.
-- Spec: docs/superpowers/specs/2026-09-10-order-communication-indicator-design.md
--
-- 15 minutes rather than the 5 the sync functions use: this one only has
-- something to do once a sync has actually landed new messages, and an
-- unchanged conversation short-circuits on its fingerprint before any model is
-- called. Operators who need an answer sooner press Re-check on the card.

select cron.unschedule('assess-order-communication-15min')
where exists (select 1 from cron.job where jobname = 'assess-order-communication-15min');

select cron.schedule(
  'assess-order-communication-15min',
  '7,22,37,52 * * * *',
  $$ select public.invoke_edge_function('assess-order-communication', '{"scope":"pending"}'::jsonb); $$
);
