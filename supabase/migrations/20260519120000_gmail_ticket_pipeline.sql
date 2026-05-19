-- Gmail ticket pipeline — schema additions on top of service_tickets.
--
-- Extends service_tickets with gmail anchors, classifier output fields, and
-- message-count / first/last-message tracking. Adds three sibling tables:
--   * ticket_messages       — per-Gmail-message rows tied to a ticket
--   * ticket_classification_log — audit trail of classifier decisions
--   * gmail_sync_state      — per-mailbox sync cursor (historyId)
--
-- Design decisions in docs/superpowers/specs/2026-05-19-gmail-ticket-pipeline-design.md.

-- ============================================================ Extend service_tickets
-- Drop the inline source check constraint and re-add with 'gmail'.
alter table public.service_tickets drop constraint if exists service_tickets_source_check;
alter table public.service_tickets add constraint service_tickets_source_check
  check (source in ('calendly','customer_form','hubspot','fulfillment_flag','ops_manual','gmail'));

alter table public.service_tickets
  add column if not exists gmail_thread_id           text,
  add column if not exists gmail_account             text,
  add column if not exists summary                   text,
  add column if not exists suggested_next_action     text,
  add column if not exists last_classified_at        timestamptz,
  add column if not exists classification_confidence numeric,
  add column if not exists message_count             integer not null default 0,
  add column if not exists first_message_at          timestamptz,
  add column if not exists last_message_at           timestamptz,
  add column if not exists is_manually_overridden    boolean not null default false;

-- Unique on gmail_thread_id (partial — only when set, since most existing
-- rows are HubSpot/Calendly/manual and have no thread id).
create unique index if not exists ux_tickets_gmail_thread
  on public.service_tickets (gmail_thread_id)
  where gmail_thread_id is not null;

create index if not exists idx_tickets_last_message
  on public.service_tickets (last_message_at desc nulls last);
create index if not exists idx_tickets_status_priority
  on public.service_tickets (status, priority, last_message_at desc nulls last);

-- ============================================================ ticket_messages
create table if not exists public.ticket_messages (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references public.service_tickets(id) on delete cascade,
  gmail_message_id text not null unique,
  direction text not null check (direction in ('inbound','outbound')),
  sender text,
  sent_at timestamptz,
  snippet text,
  body_text text,
  created_at timestamptz not null default now()
);
create index if not exists idx_msgs_ticket on public.ticket_messages (ticket_id, sent_at);
create index if not exists idx_msgs_sent on public.ticket_messages (sent_at desc);

alter table public.ticket_messages enable row level security;
create policy "msgs_select" on public.ticket_messages for select to authenticated using (true);
create policy "msgs_insert" on public.ticket_messages for insert to authenticated with check (true);
create policy "msgs_update" on public.ticket_messages for update to authenticated using (true) with check (true);

alter publication supabase_realtime add table public.ticket_messages;

-- ============================================================ ticket_classification_log
create table if not exists public.ticket_classification_log (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references public.service_tickets(id) on delete cascade,
  method text not null check (method in ('rules','llm')),
  priority text,                                  -- snapshot of decision
  category text,                                  -- snapshot of decision
  rule_id text,                                   -- which rule fired (null for llm)
  llm_input_hash text,                            -- sha256 of thread_id|last_message_id (null for rules)
  confidence numeric,                             -- 0–1 when llm; null when rules
  created_at timestamptz not null default now()
);
create index if not exists idx_clog_ticket on public.ticket_classification_log (ticket_id, created_at desc);
create index if not exists idx_clog_hash on public.ticket_classification_log (llm_input_hash)
  where llm_input_hash is not null;

alter table public.ticket_classification_log enable row level security;
create policy "clog_select" on public.ticket_classification_log for select to authenticated using (true);
create policy "clog_insert" on public.ticket_classification_log for insert to authenticated with check (true);

-- ============================================================ gmail_sync_state
-- One row per delegated mailbox. last_history_id is null on first run; sync
-- bootstraps via date-bounded thread list, then switches to history.list.
create table if not exists public.gmail_sync_state (
  mailbox text primary key,                       -- e.g. 'huayi@virgohome.io'
  last_history_id text,
  last_run_at timestamptz,
  last_run_status text,                           -- 'ok' | 'error'
  last_run_message text,                          -- error detail or summary
  threads_seen_total integer not null default 0,
  messages_seen_total integer not null default 0,
  updated_at timestamptz not null default now()
);

alter table public.gmail_sync_state enable row level security;
create policy "gss_select" on public.gmail_sync_state for select to authenticated using (true);
-- writes go through service-role from the edge function; no insert/update policy for authenticated.

create or replace function public.touch_gmail_sync_state() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists gmail_sync_state_touch on public.gmail_sync_state;
create trigger gmail_sync_state_touch before update on public.gmail_sync_state
  for each row execute function public.touch_gmail_sync_state();

-- ============================================================ Cron: Gmail every 5 min
do $$
begin
  if exists (select 1 from cron.job where jobname = 'sync-gmail-tickets-5min') then
    perform cron.unschedule('sync-gmail-tickets-5min');
  end if;
end $$;
select cron.schedule(
  'sync-gmail-tickets-5min',
  '*/5 * * * *',                                  -- every 5 minutes
  $$ select public.invoke_edge_function('sync-gmail-tickets'); $$
);
