-- Awaiting-review tracking for the Follow-Ups directory.
-- null = not asked, 'requested' = review ask sent, 'received' = review in hand.
-- Free-text (no check constraint) to match fu1_status/fu2_status convention.
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS review_status text;
COMMENT ON COLUMN public.customers.review_status IS
  'Follow-Ups review state: null=not asked, requested=ask sent, received=review in hand';
