-- Seed customer return: Kendra Sample (order #1104, Florida resident).
--
-- Mirrors Riley Sample's seed (20260421120000) with one key difference: by
-- the time this runs, the auto_create_refund_for_customer_return trigger
-- (20260421150000) already exists, so a single insert into returns also
-- creates the refund_approvals row at status='manager_review'. We then
-- refine the auto-created note with Kendra-specific context so the manager
-- sees the same quality of triage detail Riley's row has.
--
-- refund_amount_usd is set to 1049 (LILA Pro list price) on the returns row
-- so the trigger picks it up; manager adjusts during review.
--
-- Idempotent: guarded on customer_email + order ref so re-running this
-- migration is a no-op.

insert into public.returns (
  customer_name,
  customer_email,
  customer_phone,
  channel,
  original_order_ref,
  condition,
  reason,
  refund_amount_usd,
  description,
  notes,
  status,
  source,
  usage_duration,
  return_reasons,
  support_contacted,
  experience_rating,
  would_change_decision,
  future_likelihood,
  packaging_status,
  alternative_composting,
  refund_method_preference,
  refund_contact,
  additional_comments
)
select
  'Kendra Sample',
  'kendra.sample@example.com',
  '555-0101-0000',
  'USA',
  '#1104',
  'good',
  'Product Defect',
  1049,
  $$Did a video call. Unit is producing too much water for florida resident.

— Usage duration: Less than 1 week
— Selected issues: Odor issues; Compost output quality not as expected; Device malfunction or hardware issue
— Contacted support before deciding: Yes — they tried to help but the issue wasn't resolved
— Overall experience rating: 3 / 5 (Average — met some expectations)
— Would have changed decision if: "Offered my help with product testing but rhe cost does not outweigh the issues atm"
— Likely to consider LILA again: Maybe / Unsure
— Unit condition: Good — normal wear from regular use
— Original packaging: Yes — complete original packaging
— Alternative composting plan: Other electric composter
— Refund preference: Email (E-Transfer) to kendra.sample@example.com
— Additional comments: Payment thru sezzle$$,
  'Customer-submitted via makelila return form · Florida resident · Paid via Sezzle — flag for finance to verify refund routing.',
  'created',
  'customer_form',
  'Less than 1 week',
  ARRAY['Odor issues','Compost output quality not as expected','Device malfunction or hardware issue']::text[],
  'Yes — they tried to help but the issue wasn''t resolved',
  3,
  'Offered my help with product testing but rhe cost does not outweigh the issues atm',
  'Maybe / Unsure',
  'Yes — complete original packaging',
  'Other electric composter',
  'Email (E-Transfer)',
  'kendra.sample@example.com',
  'Payment thru sezzle'
where not exists (
  select 1 from public.returns
   where customer_email = 'kendra.sample@example.com'
     and original_order_ref = '#1104'
);

-- Refine the auto-created refund_approvals note (the trigger writes a
-- generic message; this gives the manager Kendra-specific context).
update public.refund_approvals ra
   set notes = 'Customer-form submission. Kendra requested E-Transfer refund to kendra.sample@example.com. Customer paid via Sezzle — verify refund routing with finance before issuing. Manager: confirm $1049 list-price amount (LILA Pro).'
  from public.returns r
 where ra.return_id = r.id
   and r.customer_email = 'kendra.sample@example.com'
   and r.original_order_ref = '#1104'
   and ra.status = 'manager_review';
