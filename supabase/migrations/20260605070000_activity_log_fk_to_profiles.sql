-- Backlog #76 follow-up — fix Activity Log KPIs reading zero.
--
-- Root cause: useActivityKpis() in app/src/lib/activityLog.ts embeds
-- `profiles(display_name)` via PostgREST. PostgREST resolves embed
-- targets by inspecting foreign keys, and activity_log.user_id's only
-- FK pointed at auth.users (a restricted schema PostgREST's
-- relationship inference can't follow), not public.profiles. So the
-- embed silently returned no rows → setEntries([]) → all KPI tiles
-- read 0.
--
-- Postgres allows multiple FKs on the same column. We add a SECOND FK
-- pointing at public.profiles so PostgREST has a relationship to
-- resolve. profiles.id = auth.users.id by design, so the data stays
-- consistent (verified zero orphan user_ids before applying).
--
-- ON DELETE SET NULL on the public.profiles side preserves audit
-- history if a profile row is ever pruned (the existing
-- activity_log_user_id_fkey → auth.users CASCADE still fires on user
-- deletion).

alter table public.activity_log
  add constraint activity_log_user_id_profiles_fkey
  foreign key (user_id) references public.profiles(id) on delete set null;
