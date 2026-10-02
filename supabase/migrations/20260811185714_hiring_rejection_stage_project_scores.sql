-- supabase/migrations/20260811120000_hiring_rejection_stage_project_scores.sql
--
-- Two additions to candidates
-- (docs/superpowers/specs/2026-08-11-hiring-interview-reject-project-scores-design.md):
--
-- 1. rejection_stage — which gate the rejection happened at. The Applicants
--    board rejects at resume screening; the Interviews board's new Reject
--    button rejects after an interview. Explicit column rather than derived
--    from held interviews, so the Applicants board can label the pill without
--    an interviews fetch per card.
--
-- 2. project_scores — the post-interview take-home project is a fixed
--    2-question exercise; scores keyed by question label, same shape as the
--    screening `scores` column.
--
-- No RLS changes: candidates_update already covers operator writes to both
-- columns, and the service-role inserts (sync-hiring-applications,
-- parse-resume-batch) are unaffected — one column is nullable, the other
-- has a default.

alter table public.candidates
  add column rejection_stage text
    check (rejection_stage in ('resume_screening','interview')),
  add column project_scores jsonb not null default '{}'::jsonb;

-- Every rejection made before this migration came from the Applicants board —
-- the interview-stage Reject button did not exist yet.
update public.candidates
  set rejection_stage = 'resume_screening'
  where rejected_at is not null;
