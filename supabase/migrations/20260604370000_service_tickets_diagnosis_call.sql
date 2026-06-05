-- Backlog #74 + #75 — diagnosis-call booking flow + Google Calendar
-- appointment-schedule sync + co-host auto-invite.
--
-- New columns on service_tickets:
--   • diagnosis_link_sent_at   — when the UI fired the booking link to
--                                the customer (dedupe so the operator
--                                doesn't double-send).
--   • diag_cohost_invited_at   — when sync-google-appointments fired the
--                                Reina + Junaid co-host invite (dedupe
--                                so the cron doesn't re-invite).
--   • google_calendar_event_id — unique key for events imported from
--                                Huayi's Google Calendar (the diagnosis
--                                appointment schedule). Mirrors the
--                                calendly_event_uri pattern.
--
-- Category enum gains 'diagnosis_call'; source enum gains 'google_calendar'.

alter table public.service_tickets
  add column if not exists diagnosis_link_sent_at timestamptz,
  add column if not exists diag_cohost_invited_at timestamptz,
  add column if not exists google_calendar_event_id text;

-- Unique index for upsert dedupe in sync-google-appointments. Partial
-- index so existing rows (NULL) don't fight for uniqueness.
create unique index if not exists ux_tickets_google_calendar_event_id
  on public.service_tickets (google_calendar_event_id)
  where google_calendar_event_id is not null;

-- Category enum: add 'diagnosis_call'. The original CHECK constraint
-- doesn't have a stable name from `create table`, so drop by introspection.
do $$
declare
  cons_name text;
begin
  select c.conname into cons_name
  from pg_constraint c
  join pg_class t on t.oid = c.conrelid
  where t.relname = 'service_tickets'
    and c.contype = 'c'
    and pg_get_constraintdef(c.oid) ilike '%category%onboarding%';
  if cons_name is not null then
    execute format('alter table public.service_tickets drop constraint %I', cons_name);
  end if;
end $$;

alter table public.service_tickets
  add constraint service_tickets_category_check
  check (category in ('onboarding','support','repair','diagnosis_call'));

-- Source enum: add 'google_calendar'. Same introspection pattern.
do $$
declare
  cons_name text;
begin
  select c.conname into cons_name
  from pg_constraint c
  join pg_class t on t.oid = c.conrelid
  where t.relname = 'service_tickets'
    and c.contype = 'c'
    and pg_get_constraintdef(c.oid) ilike '%source%calendly%';
  if cons_name is not null then
    execute format('alter table public.service_tickets drop constraint %I', cons_name);
  end if;
end $$;

alter table public.service_tickets
  add constraint service_tickets_source_check
  check (source in ('calendly','customer_form','hubspot','fulfillment_flag','ops_manual','google_calendar'));

comment on column public.service_tickets.diagnosis_link_sent_at is
  'Backlog #75: set when an operator sent the customer the diagnosis-call booking link from the ticket detail panel.';
comment on column public.service_tickets.diag_cohost_invited_at is
  'Backlog #75: set when sync-google-appointments fired the Reina + Junaid co-host invite after the customer booked.';
comment on column public.service_tickets.google_calendar_event_id is
  'Backlog #75: Google Calendar event ID for tickets imported via sync-google-appointments (appointment-schedule bookings).';
