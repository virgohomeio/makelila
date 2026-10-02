-- Diagnosis-call support cost — the labour side of cost-to-serve.
--
-- Until now nothing in makeLILA recorded how long a diagnosis call ran.
-- service_tickets carries calendly_event_start but no end time, and
-- sync-calendly-events reads Calendly's end_time and discards it
-- (supabase/functions/sync-calendly-events/index.ts). So a customer who
-- consumed three hours of engineering time looked identical, on the
-- profitability card, to one who never called.
--
-- This migration adds the two things the profitability view needs:
--   1. public.diagnosis_calls  — one row per call, with real talk time.
--   2. public.support_rates    — the blended internal person-hour rate.
--
-- ── Where the durations came from ──────────────────────────────────────────
-- Seeded from Fireflies recordings, 2026-01 through 2026-08. Two title
-- conventions had to be swept, not one:
--   • "LILA Diagnosis Chat" / "<Name> diagnosis"  — the Calendly diagnosis
--     event type, which does create a service_tickets row.
--   • "Huayi (LILA by VCycene) (<Name>)"          — Huayi's general-purpose
--     booking link, which does NOT create a ticket. 117 meetings carry this
--     title and only 27 are customer calls; the rest are co-op interviews,
--     vendor pitches, investors and founder mentoring. Those are excluded.
--
-- ── attended, and why it is not just a flag ────────────────────────────────
-- Fireflies keeps recording an empty room until it auto-leaves, so a no-show
-- lands as a ~11-12 minute recording that looks exactly like a short call.
-- Verified against raw transcripts: 01KZ6T30ZVTHQX8X0YTNFT7NEQ (Lawrence Hou)
-- has no speakers and no sentences; 01KWCJTPBK63KS49KV70E43JG7 (Lily Xu) is
-- only Huayi saying "Hello, hello". The tell is summary_status='skipped',
-- usually with silent_meeting=true.
--
-- Operator decision (Huayi, 2026-08-19): no-shows DO hit margin. The team sat
-- in the room, phoned the customer and waited — that time was paid for and it
-- was spent on this customer's account, so it belongs in cost-to-serve. The
-- attended flag is still recorded, and diagnosis_noshow_count still surfaces
-- the subset on the card, so the two are separable at a glance.
--
-- ── One blended rate, multiplied by attendee count ─────────────────────────
-- The original ask was cost = hours x (Huayi rate + Reina rate). Two changes,
-- both operator-approved (Huayi, 2026-08-19):
--
--   • Attendance actually varies. Some calls are Huayi solo; several have
--     Junaid, and the March-April calls have Ashwini. Billing a fixed pair on
--     every call overstates solo calls and misses the third and fourth person
--     entirely. Cost now scales with internal_attendees.
--
--   • Per-person rates are compensation data. A per-person table readable by
--     every operator would let anyone derive two people's pay; a finance-only
--     table would make the profitability view return NULL margins for
--     non-finance operators, which is exactly the trap the V5 migration
--     documented when it put FX rates in fx_rates instead of finance_config.
--     So: ONE blended person-hour rate, readable by all internal users, and no
--     individual salary is recoverable from it.
--
--     cost = (minutes / 60) * internal_attendees * blended_hourly_cad

-- ── Rate table ──────────────────────────────────────────────────────────────

create table if not exists public.support_rates (
  role_key    text primary key,
  hourly_cad  numeric(10,2) check (hourly_cad > 0),
  note        text,
  updated_at  timestamptz not null default now()
);

comment on table public.support_rates is
  'Blended internal labour rates for cost-to-serve. Operator-maintained; '
  'update the row rather than migrating. Deliberately NOT per-person — see '
  'the header of 20260819120000 for why.';

alter table public.support_rates enable row level security;

drop policy if exists support_rates_select on public.support_rates;
create policy support_rates_select on public.support_rates
  for select using (public.is_internal_user());

drop policy if exists support_rates_write on public.support_rates;
create policy support_rates_write on public.support_rates
  for update using (public.is_manager());

grant select on public.support_rates to authenticated;

-- Seeded NULL on purpose. A placeholder rate would silently produce
-- confident-looking wrong margins; NULL makes support_cost_cad come back NULL
-- so the card renders "rate not set" until someone fills it in. Same posture
-- as public.to_cad returning NULL for an unknown currency.
insert into public.support_rates (role_key, hourly_cad, note) values
  ('internal_person_hour', null,
   'Blended fully-loaded cost of one internal person-hour on a customer call, CAD. Set this to switch on support cost.')
on conflict (role_key) do nothing;

-- ── Call log ────────────────────────────────────────────────────────────────

create table if not exists public.diagnosis_calls (
  id                 uuid primary key default gen_random_uuid(),
  fireflies_id       text unique,
  occurred_at        timestamptz not null,
  duration_minutes   numeric(8,2) not null check (duration_minutes >= 0),
  -- How many VCycene people were on the call. Drives the cost multiplier.
  internal_attendees int not null default 1 check (internal_attendees >= 0),
  -- false = customer never joined. Recorded, not charged.
  attended           boolean not null default true,
  customer_id        uuid references public.customers(id) on delete set null,
  -- Kept alongside customer_id because several of these customers are not in
  -- public.customers at all (Karolina Chmiel, Angeline Purcell, Brent Neave),
  -- and Cheryl Lemieux books under a different address than her customer row.
  -- The profitability view falls back to email then name, same as refund_agg.
  customer_email     text,
  customer_name      text,
  title              text,
  source             text not null default 'fireflies',
  created_at         timestamptz not null default now()
);

comment on table public.diagnosis_calls is
  'One row per customer diagnosis/support call, with real talk time from the '
  'Fireflies recording. Feeds support_cost_cad on customer_profitability.';
comment on column public.diagnosis_calls.attended is
  'false = customer no-show (Fireflies recorded an empty room). Still billed '
  'into support_cost_cad — the team''s time was spent either way — but broken '
  'out as diagnosis_noshow_count so the waste stays visible.';
comment on column public.diagnosis_calls.internal_attendees is
  'Count of VCycene attendees. Cost multiplier — a solo call costs half a pair.';

create index if not exists ix_diagnosis_calls_customer on public.diagnosis_calls (customer_id);
create index if not exists ix_diagnosis_calls_email on public.diagnosis_calls (lower(customer_email));

alter table public.diagnosis_calls enable row level security;

drop policy if exists diagnosis_calls_select on public.diagnosis_calls;
create policy diagnosis_calls_select on public.diagnosis_calls
  for select using (public.is_internal_user());

drop policy if exists diagnosis_calls_write on public.diagnosis_calls;
create policy diagnosis_calls_write on public.diagnosis_calls
  for all using (public.is_manager()) with check (public.is_manager());

grant select on public.diagnosis_calls to authenticated;

-- ── Cost function ───────────────────────────────────────────────────────────

create or replace function public.diagnosis_call_cost_cad(minutes numeric, attendees int)
returns numeric
language sql
stable
as $$
  select case
    when minutes is null or attendees is null then null
    else ((minutes / 60.0) * attendees
          * (select r.hourly_cad from public.support_rates r
             where r.role_key = 'internal_person_hour'))::numeric(12,2)
  end;
$$;

comment on function public.diagnosis_call_cost_cad(numeric, int) is
  'Labour cost of one call in CAD. NULL while support_rates.hourly_cad is '
  'unset, so an unconfigured rate reads as a gap rather than as $0.';
insert into public.diagnosis_calls
  (occurred_at, fireflies_id, duration_minutes, internal_attendees, customer_name, customer_email, attended, title) values
  ('2026-03-13T15:00:00Z','01KKHGB723B4R094WQETBCTABS',14.36,3,'Karolina Chmiel','smerfusia@gmail.com',true,'LILA Diagnosis Chat'),
  ('2026-03-23T20:00:00Z','01KMDSB4FEEKHS0610G85E8GXW',11.92,2,'Angeline Purcell','angelinepurcell@gmail.com',true,'LILA Diagnosis Chat'),
  ('2026-03-25T17:30:00Z','01KMG74D94ETCJDJCCEKVMGNW4',25.10,1,'Jeffrey Van Dyke','jeffreyvandyke@comcast.net',true,'Huayi (LILA by VCycene) (Jeffrey Van Dyke)'),
  ('2026-03-27T15:00:00Z','01KMJYJ1KYX9MYRMGA10HKDYNV',33.04,2,'Mr. Phil Parkinson','philfparkinson@hotmail.com',true,'LILA Diagnosis Chat'),
  ('2026-03-30T15:30:00Z','01KMTNR3A3NCDRT0CQ9ZX7FKKD',23.10,1,'Kristi Blue','krisbl2@aol.com',true,'Huayi (LILA by VCycene) (Kristi Blue)'),
  ('2026-04-02T16:00:00Z','01KN5GY3W7SQDQVB3ZRJKSVDWB',11.64,2,'Douglas Hanson','dhanson7298@gmail.com',true,'Huayi (LILA by VCycene) (Doug Hanson)'),
  ('2026-04-08T17:00:00Z','01KNQ0CC1KEGAEFWSBVJXVE1PE',19.95,3,'Cheryl Lemieux','clemieux@kandr.com',true,'LILA Diagnosis Chat'),
  ('2026-04-09T15:00:00Z','01KNMHPKEK3PM7RYRESQQRP5DC',18.10,3,'Karolina Chmiel','smerfusia@gmail.com',true,'Huayi (LILA by VCycene) (Karolina Chmiel)'),
  ('2026-04-13T18:45:00Z','01KNZBXBXM9B4K1G3PZ8Y4F41D',18.52,1,'Cheryl Lemieux','clemieux@kandr.com',true,'Huayi (LILA by VCycene) (Cheryl Lemieux)'),
  ('2026-04-20T16:30:00Z','01KPMHDG02WJRVV3MF56YJQKJY',10.75,3,'Dhruv Talwar','dtalwar14@gmail.com',true,'Huayi (LILA by VCycene) (DHRUV TALWAR)'),
  ('2026-04-21T17:00:00Z','01KPP0SD8EZX8W65QJXQWCXV3P',11.05,3,'Dhruv Talwar','dtalwar14@gmail.com',true,'Huayi (LILA by VCycene) (DHRUV TALWAR)'),
  ('2026-04-22T16:00:00Z','01KPR68ETSNT1TB13ND3C7RWXX',14.17,3,'Karolina Chmiel','smerfusia@gmail.com',true,'Huayi (LILA by VCycene) (Karolina Chmiel)'),
  ('2026-04-27T15:30:00Z','01KQ2RWA2ZTVV2KKS2XZ9K127S',10.95,1,'Lily Xiao Xu','lilyxu1@hotmail.com',false,'Huayi (LILA by VCycene) (lily xu)'),
  ('2026-04-30T16:30:00Z','01KQAJJV53HJEE3E5502XTC68T',28.45,1,'Joy Seargeant','thejosierave@hotmail.com',true,'Huayi (LILA by VCycene) (Joy Seargeant )'),
  ('2026-05-11T16:00:00Z','01KR45X7YCQ821RG89WE18QTCS',13.83,3,'Sarah Harris','smphharris@gmail.com',true,'Huayi (LILA by VCycene) (Sarah Harris)'),
  ('2026-05-15T19:45:00Z','01KRPJMVDNG1PZ1XDQYFYFT0MW',15.09,2,'Katrina & RJ Dowd','katrinadowd83@gmail.com',true,'LILA Diagnosis Chat'),
  ('2026-05-25T17:00:00Z','01KS9503Z7DY2WC473PQ9HK7NX',11.38,1,'Fred Rice','fjrice1950@gmail.com',false,'Huayi (LILA by VCycene) (fred rice)'),
  ('2026-05-27T16:30:00Z','01KSG07T2HRQTMBRJHZJVVYV1N',30.13,2,'Ronald Hatch','rdhridgeback@gmail.com',true,'Huayi (LILA by VCycene) (Rob Hatch)'),
  ('2026-05-27T18:00:00Z','01KSMNZFTVCQYQJNP2VDVKB5WT',14.08,2,'Brent Neave','brentneave1500@gmail.com',true,'Huayi (LILA by VCycene) (Brent Neave)'),
  ('2026-06-03T15:00:00Z','01KT4ARCHBFWTM2HPER7PTCQGP',12.66,2,'Alberino Salvatore','asalvatore@sprintmechanical.com',true,'Huayi (LILA by VCycene) (Albert  Salvatote)'),
  ('2026-06-03T18:45:00Z','01KT4PB05A286D41TZXGSVJRSM',39.61,2,'Cheryl Lemieux','clemieux@kandr.com',true,'Huayi (LILA by VCycene) (Cheryl Lemieux)'),
  ('2026-06-12T17:00:00Z','01KTWASFKBZEZNVJA6DYE3ZZ4X',40.87,3,'Chad Lockhart','sarahmeecham87@icloud.com',true,'LILA Diagnosis Chat'),
  ('2026-06-15T19:30:00Z','01KV6BXQGRP1RN209KV2MF8PB4',27.07,1,'Leen Schafer','leenschafer@gmail.com',true,'LILA Diagnosis Chat'),
  ('2026-06-16T18:00:00Z','01KV668CV8XY9DDS83N5BN24VG',19.83,3,'Antonino Bonsignore','abonsignore78@gmail.com',true,'LILA Diagnosis Chat'),
  ('2026-06-16T19:30:00Z','01KV682179EWFQV61DYXPNEAE0',19.23,3,'Judy Mahon','judymml@sasktel.net',false,'LILA Diagnosis Chat'),
  ('2026-06-18T18:00:00Z','01KV99RAFYKGARN597NM32J7KE',33.85,1,'Ronald Hatch','rdhridgeback@gmail.com',true,'LILA Diagnosis Chat'),
  ('2026-06-24T18:30:00Z','01KVR05X6HD2T12Q78K5TSQ408',11.81,1,'Ronald Hatch','rdhridgeback@gmail.com',false,'Huayi (LILA by VCycene) (Ro  Hatch)'),
  ('2026-06-25T18:30:00Z','01KVXG8PBYB80P2S69K1BEQGKW',15.63,3,'Ronald Hatch','rdhridgeback@gmail.com',true,'Huayi (LILA by VCycene) (Ron Hatch)'),
  ('2026-06-27T19:00:00Z','01KVR9BZNEY9QE7G9SE5XR879C',36.95,1,'Rick Stauffer','rick@freshveggie.com',true,'LILA Diagnosis Chat'),
  ('2026-06-30T15:30:00Z','01KWCJTPBK63KS49KV70E43JG7',11.75,1,'Lily Xiao Xu','lilyxu1@hotmail.com',false,'LILA Diagnosis Chat'),
  ('2026-07-07T20:00:00Z','01KWWCX8NSNJY44S9EW5CS9TG6',15.99,2,'Chris & Renata Grant','cb.grant@hotmail.com',true,'LILA Diagnosis Chat'),
  ('2026-07-17T18:00:00Z','01KXP85WN13TPH33MA3F6FRRJB',15.64,3,'Jim Christie','jimchristie@hotmail.com',true,'LILA Diagnosis Chat'),
  ('2026-07-20T19:30:00Z','01KXYE9P86HD1WFTGV5GQSP1PA',12.98,2,'Joseph Thavundayil','thajos@douglas.mcgill.ca',false,'LILA Diagnosis Chat'),
  ('2026-07-22T15:15:00Z','01KY34QW5J18X0C0A1BV4CXBCW',73.52,2,'Joseph Thavundayil','thajos@douglas.mcgill.ca',true,'Huayi (LILA by VCycene) (Joseph  Thavundayil )'),
  ('2026-07-23T18:00:00Z','01KY2XRRWTZ1BPTAE6E0DKZCRK',11.27,2,'Esmeralda Burgess','patricia31gon@gmail.com',true,'Huayi (LILA by VCycene) (Esmeralda  Burgess)'),
  ('2026-07-27T16:00:00Z','01KYD31S5R68VX7G3TRGW97SBP',15.56,2,'Joan Teichroeb','off-the-grid@outlook.com',true,'Huayi (LILA by VCycene) (Joan Teichroeb)'),
  ('2026-07-27T18:30:00Z','01KYDQMYFMAX94P0T14G0KFFQH',15.02,2,'Thilagavathi Venkatachalam','drthilak@yahoo.com',false,'Huayi (LILA by VCycene) (Thilagavathi Venkatachalam)'),
  ('2026-07-29T18:45:00Z','01KYJFTQKD0YXSB1H1SNYCBHMF',11.64,1,'Thilagavathi Venkatachalam','drthilak@yahoo.com',false,'Huayi (LILA by VCycene) (Thilagavathi Venkatachalam)'),
  ('2026-08-06T16:00:00Z','01KZ9QXA5GKBC06DFM3DG36C87',12.33,2,'Dhruv Talwar','dtalwar14@gmail.com',false,'Huayi (LILA by VCycene) (Dhruv Talwar)'),
  ('2026-08-06T18:00:00Z','01KZ6T30ZVTHQX8X0YTNFT7NEQ',11.73,2,'Lawrence Hou','lawrencejhou@gmail.com',false,'Huayi (LILA by VCycene) (Lawrence Hou)'),
  ('2026-08-06T18:15:00Z','01KZ6T30ZK6VJ5GC6BCNKG3Q27',11.88,2,'Roxana Felipe','roxanaf79@live.com',false,'Huayi (LILA by VCycene) (Roxana Felipe)'),
  ('2026-08-10T17:45:00Z','01KZE8N3PXGJ6T9HQ49DGWB88S',18.45,2,'Antonio Gonsalves','antogonsalves@gmail.com',true,'Huayi (LILA by VCycene) (Antonio Gonsalves)')
on conflict (fireflies_id) do nothing;

-- Link to customers where the email matches. Rows that stay NULL are joined by
-- email/name in the view instead.
update public.diagnosis_calls dc
set customer_id = c.id
from public.customers c
where dc.customer_id is null
  and dc.customer_email is not null
  and lower(c.email) = lower(dc.customer_email);
