-- Follow-up to 20260529100000_service_inbox.sql:
--   1. Rename indexes to match the repo convention (ux_tickets_* / idx_tickets_*)
--      established by 20260512100000_service_module_schema.sql and
--      20260519120000_gmail_ticket_pipeline.sql.
--   2. Drop the now-redundant non-unique partial index that was created in
--      20260527210000_service_tickets_quo_source.sql — the new unique
--      index covers the same column with the same predicate.
--
-- Race-window note: the cron 'sync-quo-tickets-5min' continued running
-- between the prior migration applying and the sync-quo-tickets edge fn
-- being redeployed to handle 23505 races. Bounded damage: no new
-- duplicate rows can be created (the unique index blocks them), but a
-- small number of message-append cron runs may have failed and will
-- self-heal on the next 5-minute tick once the new edge fn deploys.

alter index if exists public.service_tickets_quo_conv_uniq
  rename to ux_tickets_quo_conv;

alter index if exists public.service_tickets_kind_idx
  rename to idx_tickets_kind_last_message;

drop index if exists public.idx_service_tickets_quo_conversation;
