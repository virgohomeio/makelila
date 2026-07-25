-- BR-16: daily cron that runs the send-return-followups edge function, which
-- reminds customers whose return has stalled at the intake stage (7-13 days) and
-- escalates ones past 14 days. Mirrors the send-refund-reminders schedule.
-- (Applied to prod via the Supabase MCP alongside the edge-function deploy.)
select cron.schedule(
  'send-return-followups',
  '0 15 * * *',
  $$ select public.invoke_edge_function('send-return-followups', '{}'::jsonb) $$
);
