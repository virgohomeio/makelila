-- Refund workflow — customer email policy, revised 2026-08-04 (Huayi).
--
-- Decision: in the refund/return workflow a customer hears from us AUTOMATICALLY
-- exactly twice:
--   1. the return-form confirmation (send-return-emails, on form submit), and
--   2. the refund-sent notice when the card reaches the Refunded column
--      (executeRefund → 'refund_funds_sent_customer'), which now states the
--      7–10 business day window.
-- Every other automatic customer email in this workflow is stopped.
--
-- Code side (app/src/lib/postShipment.ts, same change): the FR-15 transition
-- emails on compile ('refund_application_received_customer'), manager approval
-- ('refund_approved_customer') and finance queueing ('refund_processing_customer')
-- no longer fire. Internal notifications (refund_queued_executor,
-- refund_executed_am, refund_reminder_digest) are unaffected — those go to staff.
--
-- The now-unused customer templates are deliberately left `active` so operators
-- can still send one by hand from the Templates module; only the automatic
-- sending is removed.

-- 1. Refunded-column email: state the 7–10 business day expectation.
update public.email_templates
   set subject = 'Your LILA refund has been sent',
       body = E'Hi {{customer_first_name}},\n\nYour refund of {{amount}} has been sent via {{method}}.\n\nPlease allow 7–10 business days for the funds to appear in your account — the exact timing depends on your bank or payment provider. If you don''t see it after that, just reply to this email and we''ll look into it right away.\n\nThank you,\nThe VCycene / LILA team',
       description = 'FR-15: the only automatic customer email after the return-form confirmation — sent when the refund card reaches Refunded. States the 7–10 business day window.'
 where key = 'refund_funds_sent_customer';

-- 2. BR-16 customer nudge (send-return-followups) — stop the automatic
--    7-day reminder to customers whose return sits in Return Form Submitted.
--    The edge function and its cron entry stay in place, just inactive, so this
--    is a one-line revert if the policy changes. The 14-day escalation flag is
--    unaffected in the DB, but note it is stamped by the same (now dormant) job.
select cron.alter_job(jobid, active := false)
  from cron.job
 where jobname = 'send-return-followups';
