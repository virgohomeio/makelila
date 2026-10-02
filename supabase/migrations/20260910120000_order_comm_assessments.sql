-- Customer communication indicator (Sales tab).
-- Spec: docs/superpowers/specs/2026-09-10-order-communication-indicator-design.md
--
-- One derived row per order holding the "clear to ship / communication unclear"
-- verdict computed by the assess-order-communication edge function from the
-- customer's Quo + support-email history. This is a cache of a model's reading
-- of ticket_messages, never operator-curated data — the edge function is free
-- to overwrite it wholesale.

create table if not exists public.order_comm_assessments (
  order_id          uuid primary key references public.orders(id) on delete cascade,

  -- 'no_contact' is deliberately distinct from 'clear': both are safe to ship,
  -- but only one of them means a person actually said so. The UI words them
  -- differently and the difference matters when auditing a bad shipment.
  verdict           text        not null
                                check (verdict in ('clear', 'unclear', 'no_contact')),
  headline          text        not null,

  -- Fixed vocabulary so the UI can label concerns without parsing prose.
  concerns          text[]      not null default '{}',

  -- [{channel, direction, sent_at, excerpt, ticket_id}], newest first, <= 3.
  evidence          jsonb       not null default '[]'::jsonb,

  -- {quo: {connected, last_synced_at, message_count}, email: {...}}. Recorded
  -- per assessment so a "clear to ship" can never be silently based on half
  -- the evidence: the card states which channels it actually read.
  channels_scanned  jsonb       not null default '{}'::jsonb,

  message_count     integer     not null default 0,
  last_message_at   timestamptz,

  -- sha256 over the message ids fed to the model. Unchanged fingerprint means
  -- nothing new was said, so the cron re-runs cost nothing.
  input_fingerprint text,
  model             text,
  assessed_at       timestamptz not null default now(),

  -- Last provider failure. Set alongside a retained previous verdict, so a
  -- transient LLM outage degrades to a stale answer rather than to no answer.
  error             text
);

comment on table public.order_comm_assessments is
  'Derived per-order verdict on whether recent customer communication (Quo + support email) casts doubt on shipping. Written only by assess-order-communication.';

-- The Sales queue reads these newest-doubt-first when it renders row chips.
create index if not exists order_comm_assessments_verdict_idx
  on public.order_comm_assessments (verdict, last_message_at desc);

alter table public.order_comm_assessments enable row level security;

-- Read: any internal operator. Write: service role only (the edge function).
-- No operator-facing write policy — a human correcting this row would be
-- overwritten by the next cron pass, so the fix belongs in the order notes.
drop policy if exists order_comm_assessments_read on public.order_comm_assessments;
create policy order_comm_assessments_read
  on public.order_comm_assessments
  for select
  using (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.is_internal = true
    )
  );

-- Realtime so an operator watching an order sees the verdict land without a
-- reload (the cron can finish seconds after they open the detail panel).
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'order_comm_assessments'
  ) then
    alter publication supabase_realtime add table public.order_comm_assessments;
  end if;
end $$;
