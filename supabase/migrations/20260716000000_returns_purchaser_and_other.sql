-- Return form additions (2026-07):
--   • "Other" free-text for the primary-reason dropdown (category_other).
--     The "Other" free-text for the multi-select reasons is folded into the
--     existing return_reasons array ("Other — <text>"), so no column needed.
--   • Purchaser identity, when the person filing the return isn't the buyer.
--     The refund workflow surfaces purchaser_name as the customer on the card.
-- All nullable/additive — legacy rows keep NULL (is_purchaser NULL = not asked).
ALTER TABLE returns
  ADD COLUMN IF NOT EXISTS is_purchaser    boolean,
  ADD COLUMN IF NOT EXISTS purchaser_name  text,
  ADD COLUMN IF NOT EXISTS purchaser_email text,
  ADD COLUMN IF NOT EXISTS purchaser_phone text,
  ADD COLUMN IF NOT EXISTS category_other  text;
