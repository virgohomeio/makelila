-- Sample customer-form submission: Ron Russell, P100 unit LL01-00000000302.
--
-- This is real customer data captured from the legacy Jotform return form
-- (LILA Pro Return Form) submitted by Ron Russell. We're back-filling it
-- into our new returns table so ops sees it on the Post-Shipment → Returns
-- tab and can drive it through pickup_scheduled → received → inspected →
-- refunded (or kick off a refund_approval row).
--
-- The form has more questions than our current schema columns capture
-- (usage duration, multi-select reasons, support contact, star rating,
-- packaging status, alternative composting, refund-method preference).
-- All of that is preserved as structured text inside description for
-- now; a future schema iteration can promote the high-value fields to
-- dedicated columns.

insert into public.returns (
  customer_name,
  customer_email,
  customer_phone,
  channel,
  unit_serial,
  original_order_ref,
  condition,
  reason,
  description,
  notes,
  status,
  source
) values (
  'Ron Russell',
  'ron@newcmi.ca',
  '(604) 834-4451',
  'Canada',
  'LL01-00000000302',
  '#1239',
  'used',
  'Product Defect',
  $$Software glitch. Keeps showing errors. Starts to smell.

— Usage duration: Less than 1 week
— Selected issues: Odor issues; Difficult to use or maintain; Device malfunction or hardware issue
— Contacted support before deciding: Yes — they tried to help but the issue wasn't resolved
— Overall experience rating: 2 / 5 (Below expectations — significant issues)
— Would have changed decision if: "If it worked all the time. and didn't smell."
— Likely to consider LILA again: Probably Not
— Unit condition: Like new — minimal use, no damage
— Original packaging: Partial — some packaging materials
— Alternative composting plan: None — not composting anymore
— Refund preference: Credit Card (customer asked us to call to process) — phone 604-834-4451 (form typo "6014-834-4451")$$,
  'Customer reference: CRT-44511 · Customer-submitted via legacy Jotform · Triage and create refund_approval next.',
  'created',
  'customer_form'
);
