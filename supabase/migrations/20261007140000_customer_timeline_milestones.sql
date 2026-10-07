-- Customers > Timelines — operator-entered milestone dates.
-- Spec: docs/superpowers/specs/2026-10-07-customer-timelines-tab-design.md
--
-- The Timelines tab shows six milestones per customer, each DERIVED from
-- existing data first (orders.placed_at, units.shipped_at,
-- shipments.delivered_at, service_tickets.calendly_event_start,
-- customer_lifecycle, customer_events). Two of those derivations are nearly
-- empty in practice — `onboarded` resolves for 5 customers and `first_use` for
-- 19, against 179 who own a machine — so an operator needs to be able to type
-- a date in. A manual date WINS over the derived value and never destroys it:
-- clear the override and the derivation comes back.
--
-- ─── Why this table owns only THREE of the six ───────────────────────────────
--
-- Three milestones already have an operator-writable home on `customers`, and
-- those columns are read elsewhere:
--
--   onboarding_call → customers.onboard_date   (122 rows; the anchor the FU1/FU2
--                                               follow-up calendar counts from,
--                                               and the Refunds tab's basis)
--   shipped         → customers.shipped_on
--   received        → customers.received_on
--
-- Writing those into a second table would mean the Timelines tab and the
-- follow-up calendar disagreeing about the same date with no error anywhere —
-- the same split-brain that made customers.serials a stale cache. So the
-- Timelines tab writes them through updateCustomerProfile(), where the rest of
-- the app already reads them, and this table carries only the three with
-- nowhere else to live.
--
-- The CHECK below is deliberately narrow rather than future-proof: a stray
-- 'onboarding_call' row here would be a date invisible to the FU calendar, so
-- the database refuses it.

create table if not exists public.customer_timeline_milestones (
  id          uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  milestone   text not null check (milestone = any (array[
                'ordered','onboarded','first_use'
              ])),
  -- `date`, not timestamptz: an operator types a calendar day, and the three
  -- sibling columns on `customers` (onboard_date, shipped_on, received_on) are
  -- `date` too. Derived values keep their full timestamp; lib/customerTimeline
  -- normalises both to a day before comparing or diffing them.
  occurred_at date not null,
  note        text,
  -- Operator email rather than auth.uid(): the panel prints who set a date
  -- beside it, and every other operator-attribution column in this schema
  -- (refund_notes.author_email, returns.inspected_by) is an email too.
  set_by      text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- One date per customer per milestone. This pair is the upsert target in
  -- lib/customerTimeline.ts:setMilestoneOverride.
  unique (customer_id, milestone)
);

create index if not exists idx_timeline_milestones_customer
  on public.customer_timeline_milestones (customer_id);

comment on table public.customer_timeline_milestones is
  'Operator-entered dates for the three Customers > Timelines milestones with no column of their own (ordered, onboarded, first_use). Overrides the derived value; deleting the row restores the derivation. The other three milestones are stored on customers.onboard_date / shipped_on / received_on so the follow-up calendar reads the same number.';
comment on column public.customer_timeline_milestones.occurred_at is
  'The calendar day the operator says the milestone happened. Takes precedence over anything derived from orders/units/shipments/tickets/lifecycle/events.';
comment on column public.customer_timeline_milestones.set_by is
  'Email of the operator who set the date. Shown beside the value in the detail panel.';

-- ============================================================ updated_at

create or replace function public.touch_customer_timeline_milestones()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists trg_touch_customer_timeline_milestones
  on public.customer_timeline_milestones;
create trigger trg_touch_customer_timeline_milestones
  before update on public.customer_timeline_milestones
  for each row execute function public.touch_customer_timeline_milestones();

-- ============================================================ RLS

-- Mirrors ticket_notes: every signed-in operator may read and write. There is
-- no per-column ownership here the way refund_notes has — a delivery date is
-- not owned by a team.
alter table public.customer_timeline_milestones enable row level security;

drop policy if exists "timeline_milestones_select" on public.customer_timeline_milestones;
drop policy if exists "timeline_milestones_insert" on public.customer_timeline_milestones;
drop policy if exists "timeline_milestones_update" on public.customer_timeline_milestones;
drop policy if exists "timeline_milestones_delete" on public.customer_timeline_milestones;

create policy "timeline_milestones_select" on public.customer_timeline_milestones
  for select to authenticated using (true);
create policy "timeline_milestones_insert" on public.customer_timeline_milestones
  for insert to authenticated with check (true);
create policy "timeline_milestones_update" on public.customer_timeline_milestones
  for update to authenticated using (true) with check (true);
create policy "timeline_milestones_delete" on public.customer_timeline_milestones
  for delete to authenticated using (true);

-- Realtime: the Timelines matrix subscribes so a date typed by one operator
-- lands on another's open tab.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'customer_timeline_milestones'
  ) then
    alter publication supabase_realtime add table public.customer_timeline_milestones;
  end if;
end $$;
