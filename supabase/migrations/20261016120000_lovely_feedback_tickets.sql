-- Lovely app in-app feedback (bug / idea / other) → support tickets.
-- Spec: docs/superpowers/specs/2026-10-16-lovely-feedback-and-stuck-setup-design.md
--
-- sync-lovely-tickets already runs every 15 minutes for damage reports
-- (20261005120000_lovely_app_tickets.sql); it now also inserts one
-- service_tickets row per row in the Lovely project's feedback table, read via
-- the lovely-feedback edge function. No new cron and no source change: these
-- are 'lovely_app' tickets like damage reports.

-- ============================================================ lovely_feedback_id

alter table public.service_tickets
  add column if not exists lovely_feedback_id uuid;

create unique index if not exists idx_tickets_lovely_feedback_id
  on public.service_tickets (lovely_feedback_id)
  where lovely_feedback_id is not null;

comment on column public.service_tickets.lovely_feedback_id is
  'Lovely project feedback.id this ticket was created from (source = lovely_app). Insert-only: the sync never updates the ticket afterwards.';

-- ============================================================ lovely_feedback_photo_path

-- Copied at sync time because, unlike damage-report photos, the Lovely
-- feedback table isn't anon-readable, so the detail panel can't look it up.
alter table public.service_tickets
  add column if not exists lovely_feedback_photo_path text;

comment on column public.service_tickets.lovely_feedback_photo_path is
  'Object path in the Lovely project''s private feedback-photos bucket, signed on demand by the lovely-damage-photos function. Null when the feedback had no photo.';
