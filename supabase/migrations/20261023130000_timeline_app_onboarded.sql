-- Customers > Timelines — new milestone: "Signed onto Lovely app".
--
-- Derived from the Lovely project's users.onboarding_step = 'tour_done' (the
-- customer finished the app's onboarding sequence and started using it). Like
-- ordered / onboarded / first_use it has no column of its own on `customers`,
-- so an operator-entered date lives here. Widen the CHECK to allow it.

alter table public.customer_timeline_milestones
  drop constraint if exists customer_timeline_milestones_milestone_check;

alter table public.customer_timeline_milestones
  add constraint customer_timeline_milestones_milestone_check
  check (milestone = any (array['ordered','app_onboarded','onboarded','first_use']));
