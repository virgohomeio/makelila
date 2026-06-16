-- Customer-journey event substrate for the lilalovely (beta-lovely)
-- integration. Two new tables:
--   - customer_app_links: maps lilalovely auth UUIDs to makelila customers
--   - customer_events: append-only event stream of customer-side signals
--     (signups, onboarding step transitions, dashboard opens, OTA accepts,
--     damage reports, push opt-ins, dormancy, etc.)
--
-- Owned by makelila. Lilalovely's Supabase project (arfdopgbvlfmhmcfghhl)
-- emits events via webhooks → makelila edge function `ingest-lovely-event`
-- → these tables. Operators consume via the Customers module + JourneyTab.
--
-- Spec: docs/integration-lilalovely-2026-06-07.md
-- Companion: edge function ingest-lovely-event (deployed separately)

-- ============================================================
-- 1. customer_app_links
--    One row per lilalovely user. The join is:
--      lovely.users.id ↔ customer_app_links.lovely_user_id
--                     ↔ customer_app_links.customer_id
--                     ↔ public.customers.id
--    Populated by the ingest edge function on first event. Resolution
--    strategy: prefer serial_number → units.customer_id; fall back to
--    email ↔ customers.email; null customer_id allowed (unresolved).
-- ============================================================
create table if not exists public.customer_app_links (
  lovely_user_id uuid primary key,
  customer_id   uuid references public.customers(id) on delete cascade,
  email         text,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  resolution    text not null check (resolution in ('serial', 'email', 'unresolved'))
);

create index if not exists idx_customer_app_links_customer
  on public.customer_app_links(customer_id);
create index if not exists idx_customer_app_links_email
  on public.customer_app_links(lower(email));

alter table public.customer_app_links enable row level security;

-- Internal users can read all links; service role inserts/updates via the
-- edge function. Same gate as the rest of makelila (is_internal_user()).
drop policy if exists "customer_app_links_select_internal"
  on public.customer_app_links;
create policy "customer_app_links_select_internal"
  on public.customer_app_links for select
  to authenticated
  using (public.is_internal_user());

-- ============================================================
-- 2. customer_events
--    Append-only stream. event_type is free-form lowercase-snake-case but
--    convention is `<source>.<verb>` e.g. lovely.signup, lovely.dashboard_open,
--    lovely.onboarding_step, lovely.dormancy_30d. The full set is enumerated
--    in docs/integration-lilalovely-2026-06-07.md §"Events to emit (V1)".
--
--    customer_id may be null when the inbound event came from an
--    unresolved lovely user (no serial paired yet AND email doesn't match
--    a customer record). Resolved later via re-scan once they pair.
-- ============================================================
create table if not exists public.customer_events (
  id              uuid primary key default gen_random_uuid(),
  customer_id     uuid references public.customers(id) on delete cascade,
  lovely_user_id  uuid,
  event_type      text not null,
  event_payload   jsonb not null default '{}'::jsonb,
  source          text not null default 'lovely'
                  check (source in ('lovely', 'makelila', 'shopify', 'klaviyo', 'system')),
  occurred_at     timestamptz not null default now(),
  ingested_at     timestamptz not null default now(),
  raw_payload     jsonb
);

-- The most common reads: per-customer timeline (newest first) + per-event-type
-- analytics (e.g. all lovely.onboarding_step in the last 30 days).
create index if not exists idx_customer_events_customer_time
  on public.customer_events(customer_id, occurred_at desc)
  where customer_id is not null;
create index if not exists idx_customer_events_lovely_user_time
  on public.customer_events(lovely_user_id, occurred_at desc);
create index if not exists idx_customer_events_type_time
  on public.customer_events(event_type, occurred_at desc);
create index if not exists idx_customer_events_unresolved
  on public.customer_events(ingested_at)
  where customer_id is null;

alter table public.customer_events enable row level security;

drop policy if exists "customer_events_select_internal"
  on public.customer_events;
create policy "customer_events_select_internal"
  on public.customer_events for select
  to authenticated
  using (public.is_internal_user());

-- ============================================================
-- 3. Helper view — per-customer engagement summary.
--    Used by the JourneyTab dormancy badge + OverdueFollowupPanel re-sort.
--    SECURITY INVOKER is fine: queries flow through the underlying
--    customer_events RLS.
-- ============================================================
create or replace view public.customer_engagement_summary as
select
  c.id as customer_id,
  c.email,
  c.full_name,
  l.lovely_user_id,
  l.first_seen_at as app_first_seen_at,
  l.last_seen_at  as app_last_seen_at,
  max(ce.occurred_at) filter (where ce.event_type = 'lovely.dashboard_open') as last_dashboard_open_at,
  max(ce.occurred_at) filter (where ce.event_type = 'lovely.batch_complete_seen') as last_batch_seen_at,
  max(ce.occurred_at) as last_event_at,
  count(ce.id) filter (where ce.occurred_at >= now() - interval '30 days') as events_30d,
  count(ce.id) filter (where ce.occurred_at >= now() - interval '7 days')  as events_7d,
  case
    when l.last_seen_at is null then null
    else extract(day from now() - l.last_seen_at)::int
  end as dormancy_days
from public.customers c
left join public.customer_app_links l on l.customer_id = c.id
left join public.customer_events ce on ce.customer_id = c.id
group by c.id, c.email, c.full_name, l.lovely_user_id, l.first_seen_at, l.last_seen_at;

grant select on public.customer_engagement_summary to authenticated;
