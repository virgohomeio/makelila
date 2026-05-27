-- Alpha-feedback P1 #2: Returns & Refunds overhaul.
-- See docs/superpowers/specs/2026-05-27-returns-refunds-overhaul-design.md

-- 1. Return category enum + column
create type return_category as enum (
  'product_defect', 'software_issue', 'shipping_damage',
  'customer_service', 'financing', 'other'
);
alter table public.returns add column return_category return_category;

-- 2. Refund method enum + columns on refund_approvals
create type refund_method as enum (
  'shopify', 'sezzle', 'quickbooks_cc', 'bank_etransfer', 'original_card'
);
alter table public.refund_approvals
  add column refund_method refund_method,
  add column original_amount_usd numeric(10,2),
  add column amount_correction_note text;

-- 3. Backfill: capture as-submitted amount once
update public.refund_approvals
   set original_amount_usd = refund_amount_usd
 where original_amount_usd is null;
