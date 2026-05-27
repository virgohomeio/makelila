-- Quo (OpenPhone) → service_tickets pipeline (Alpha P3 #9 follow-up; Huayis
-- decisions: polling, Lila Pro Service line only, one ticket per customer).
--
-- Extends source check + adds two dedup columns:
--   quo_conversation_id  — OpenPhone conversation ID (one per customer)
--   quo_last_message_id  — last message we've ingested (for incremental sync)

alter table public.service_tickets drop constraint if exists service_tickets_source_check;
alter table public.service_tickets add constraint service_tickets_source_check
  check (source = any (array['calendly','customer_form','hubspot','fulfillment_flag','ops_manual','gmail','quo']));

alter table public.service_tickets
  add column if not exists quo_conversation_id text,
  add column if not exists quo_last_message_id text;

create index if not exists idx_service_tickets_quo_conversation on public.service_tickets (quo_conversation_id)
  where quo_conversation_id is not null;
