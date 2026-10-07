-- supabase/migrations/20260723140000_refund_fee_breakdown.sql
--
-- FR-12 (Refund & Return Approval PRD): encode the refund fee breakdown on the
-- card so Finance sees the components and the audit trail is complete (goal G4).
--   * restocking_fee_usd   — BR-10: $50 CAD restocking, applied by default,
--                            waived for genuine-defect cases (BR-7).
--   * return_shipping_fee_usd — BR-9: customer pays return shipping across the
--                            board (deducted from the refund), waived for
--                            genuine-defect cases.
--
-- OQ-2 (fixed vs actual-cost return shipping) is resolved here as OPERATOR-
-- ENTERED actual cost: Finance types the real return-shipping cost on the card
-- (defaulting to 0), rather than a hard-coded fixed number. If the team later
-- standardises a fixed deduction, it's a default change in the UI, not a schema
-- change. OQ-1 decision applies: current fee terms are honoured (no
-- policy-at-purchase lookup).
--
-- Nullable: set when Finance approves. The net (refund_amount_usd) is what's
-- actually paid out; these columns record how it was derived.

alter table public.refund_approvals
  add column restocking_fee_usd numeric(10,2) null,
  add column return_shipping_fee_usd numeric(10,2) null;

comment on column public.refund_approvals.restocking_fee_usd is
  'FR-12/BR-10: restocking fee deducted from the refund ($50 default, waived for genuine-defect cases).';
comment on column public.refund_approvals.return_shipping_fee_usd is
  'FR-12/BR-9: return-shipping cost deducted from the refund (operator-entered actual cost, waived for genuine-defect cases).';
