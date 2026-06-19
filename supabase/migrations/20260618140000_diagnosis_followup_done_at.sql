-- Completion stamp for the post-diagnosis-call follow-up (call date + 14 days).
-- null = follow-up not yet done. Drives the Follow-Ups "diagnosis follow-up" track.
ALTER TABLE public.service_tickets
  ADD COLUMN IF NOT EXISTS diagnosis_followup_done_at timestamptz;
COMMENT ON COLUMN public.service_tickets.diagnosis_followup_done_at IS
  'When the 2-week post-diagnosis-call follow-up was completed (null = pending).';
