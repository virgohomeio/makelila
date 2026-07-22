-- supabase/migrations/20260722150000_returns_purchaser_linkage_confirm.sql
--
-- FR-11 / BR-14 / BR-15 (Refund & Return Approval PRD): a refund cannot be
-- processed without valid purchaser linkage — only the paying customer can be
-- refunded, to prevent double refunds and refunding the wrong party on gift /
-- household cases (goal G6).
--
-- The return form already captures is_purchaser + purchaser_* identity +
-- purchase_proof. This adds the Return Manager's OVERRIDE path (BR-15): when a
-- legitimate applicant cannot produce a receipt (very old gift, lost email),
-- the manager may manually confirm the purchaser linkage — mirroring the BR-3
-- 30-day exception — so these cases aren't permanently stuck.

alter table public.returns
  add column purchaser_linkage_confirmed_at timestamptz null,
  add column purchaser_linkage_confirmed_by uuid null references public.profiles(id) on delete set null;

comment on column public.returns.purchaser_linkage_confirmed_at is
  'FR-11/BR-15: set when the Return Manager manually confirms purchaser linkage for a legitimate no-receipt case, overriding the automatic linkage gate.';
