-- supabase/migrations/20260724140000_hiring_schema.sql
--
-- Hiring module core schema (PRD §4.15). Four tables behind a shared
-- can_view_posting() RLS helper: leadership (is_finance(), which already
-- means finance-or-admin) sees everything; anyone else needs an explicit
-- posting_interviewers row for that specific posting. All four tables use
-- the same helper so a reviewer added to one posting never sees another.

create table public.job_postings (
  id                uuid        primary key default gen_random_uuid(),
  title             text        not null,
  department        text,
  location          text,
  comp_range        text,
  status            text        not null default 'open'
                      check (status in ('open','on_hold','closed')),
  indeed_url        text,
  linkedin_url      text,
  job_description   text,
  screening_rubric  jsonb       not null default '[]'::jsonb,   -- [{dimension, weight_pct}]
  pipeline_stages   jsonb       not null default '["Applied","Screening","Interview","Offer"]'::jsonb,
  created_by        uuid        references auth.users(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create table public.candidates (
  id                  uuid        primary key default gen_random_uuid(),
  posting_id          uuid        not null references public.job_postings(id) on delete cascade,
  full_name           text        not null,
  email               text,
  phone               text,
  source              text        not null default 'other'
                        check (source in ('indeed','linkedin','referral','other')),
  resume_url          text,
  ingested_via        text        not null default 'manual_upload'
                        check (ingested_via in ('email_sync','manual_upload')),
  enrichment_status   text        not null default 'resume_attached'
                        check (enrichment_status in ('stub','resume_attached')),
  indeed_relay_email  text,
  indeed_dashboard_url text,
  qualifications_tags text[]     not null default '{}',
  stage_index         int        not null default 0,
  scores              jsonb      not null default '{}'::jsonb,       -- {dimension: score} operator
  suggested_scores    jsonb,                                          -- {dimension: score} Claude
  applied_at          timestamptz not null default now(),
  rejected_at         timestamptz,
  hired_at            timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index idx_candidates_posting on public.candidates (posting_id);
create index idx_candidates_stub_lookup on public.candidates (posting_id, full_name)
  where enrichment_status = 'stub';
create index idx_candidates_rejected_at on public.candidates (rejected_at) where rejected_at is not null;

create table public.posting_interviewers (
  id          uuid        primary key default gen_random_uuid(),
  posting_id  uuid        not null references public.job_postings(id) on delete cascade,
  profile_id  uuid        not null references public.profiles(id) on delete cascade,
  added_by    uuid        references auth.users(id),
  created_at  timestamptz not null default now(),
  unique (posting_id, profile_id)
);

create table public.interviews (
  id                 uuid        primary key default gen_random_uuid(),
  candidate_id       uuid        not null references public.candidates(id) on delete cascade,
  round_label        text        not null,
  interviewer_id     uuid        references public.profiles(id),
  calendly_event_uri text        unique,
  scheduled_at       timestamptz,
  held_at            timestamptz,
  decision           text        check (decision in ('advance','reject','hold','no_show')),
  decision_notes     text,
  decided_by         uuid        references auth.users(id),
  decided_at         timestamptz,
  created_at         timestamptz not null default now()
);
create index idx_interviews_candidate on public.interviews (candidate_id);

-- ─── Visibility helper ──────────────────────────────────────────────────
-- Leadership (is_finance() already covers finance+admin) sees every
-- posting. Everyone else needs an explicit posting_interviewers row for
-- that specific posting_id — added by whoever schedules them onto it.
create or replace function public.can_view_posting(p_posting_id uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_finance() or exists (
    select 1 from public.posting_interviewers
    where posting_id = p_posting_id and profile_id = auth.uid()
  );
$$;
grant execute on function public.can_view_posting(uuid) to authenticated;

alter table public.job_postings enable row level security;
alter table public.candidates enable row level security;
alter table public.posting_interviewers enable row level security;
alter table public.interviews enable row level security;

create policy "job_postings_select" on public.job_postings
  for select to authenticated using (public.can_view_posting(id));
create policy "job_postings_insert" on public.job_postings
  for insert to authenticated with check (public.is_finance());
create policy "job_postings_update" on public.job_postings
  for update to authenticated using (public.can_view_posting(id)) with check (public.can_view_posting(id));

create policy "candidates_select" on public.candidates
  for select to authenticated using (public.can_view_posting(posting_id));
-- No client-side insert policy: sync-hiring-applications and
-- parse-resume-batch both write via the service-role client. Operators
-- update existing rows (stage, scores, rejected_at, hired_at) directly.
create policy "candidates_update" on public.candidates
  for update to authenticated
  using (public.can_view_posting(posting_id))
  with check (public.can_view_posting(posting_id));

create policy "posting_interviewers_select" on public.posting_interviewers
  for select to authenticated using (public.can_view_posting(posting_id));
create policy "posting_interviewers_insert" on public.posting_interviewers
  for insert to authenticated with check (public.is_finance());
create policy "posting_interviewers_delete" on public.posting_interviewers
  for delete to authenticated using (public.is_finance());

create policy "interviews_select" on public.interviews
  for select to authenticated using (
    public.can_view_posting((select posting_id from public.candidates where id = candidate_id))
  );
create policy "interviews_insert" on public.interviews
  for insert to authenticated with check (
    public.can_view_posting((select posting_id from public.candidates where id = candidate_id))
  );
create policy "interviews_update" on public.interviews
  for update to authenticated
  using (public.can_view_posting((select posting_id from public.candidates where id = candidate_id)))
  with check (public.can_view_posting((select posting_id from public.candidates where id = candidate_id)));

alter publication supabase_realtime add table public.job_postings;
alter publication supabase_realtime add table public.candidates;
alter publication supabase_realtime add table public.interviews;

-- Extend the shared activity_log entity-type enum (pattern established by
-- the Products module's 20260717120000_product_issues.sql migration).
alter type public.activity_entity_type add value 'candidate';
alter type public.activity_entity_type add value 'job_posting';

-- updated_at triggers, mirroring 20260512100000_service_module_schema.sql's
-- touch_lifecycle_updated_at pattern (one shared function, reused).
create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;

create trigger job_postings_touch before update on public.job_postings
  for each row execute function public.touch_updated_at();
create trigger candidates_touch before update on public.candidates
  for each row execute function public.touch_updated_at();
