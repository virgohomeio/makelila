-- supabase/migrations/20260724150000_hiring_schema_fixes.sql
--
-- Two fixes from Task 1's code review (docs/superpowers/plans/2026-07-24-hiring-module.md):
--
-- 1. job_postings_update was gated on can_view_posting() — the same check
--    that grants view access to assigned interviewers also let them edit
--    comp_range/job_description/status. Per product decision, posting edits
--    are leadership-only (matches job_postings_insert and
--    posting_interviewers_insert, both already is_finance()-gated);
--    interviewers get view-only access to postings they're assigned to.
--
-- 2. interviews.interviewer_id had no ON DELETE behavior on its FK to
--    profiles(id), defaulting to RESTRICT — inconsistent with every other
--    nullable FK to profiles(id) elsewhere in this codebase (e.g.
--    dataset_labels.labeled_by, customers.journey_stage_override_by),
--    which all use ON DELETE SET NULL. Left as RESTRICT, offboarding a
--    profile who ever interviewed a candidate would fail with an FK
--    violation.

drop policy if exists "job_postings_update" on public.job_postings;
create policy "job_postings_update" on public.job_postings
  for update to authenticated using (public.is_finance()) with check (public.is_finance());

alter table public.interviews
  drop constraint interviews_interviewer_id_fkey;
alter table public.interviews
  add constraint interviews_interviewer_id_fkey
  foreign key (interviewer_id) references public.profiles(id) on delete set null;
