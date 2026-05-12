-- Expand returns + order_cancellations schemas to capture every field on
-- the legacy Jotforms. Previous schema stuffed the extras into description
-- as text; now they're first-class columns ops can filter / report on.
--
-- Return Form (17 fields) → public.returns gets:
--   usage_duration         e.g. "Less than 1 week"
--   return_reasons         text[] of selected multi-select boxes
--   support_contacted      enum-ish text
--   experience_rating      1-5 stars
--   would_change_decision  textarea
--   future_likelihood      "Definitely Not" / etc
--   packaging_status       "Yes — complete" / "Partial" / "No"
--   alternative_composting "Green bin" / "Outdoor bin" / etc
--   refund_method_preference   "Email (E-Transfer)" / "Credit Card"
--   refund_contact         text (e-transfer email or callback phone)
--   additional_comments    final textarea
--
-- Cancellation Form (15 fields) → public.order_cancellations gets:
--   preferred_contact      'email' | 'phone'
--   order_date             date
--   product_name           text
--   order_amount_usd       numeric
--   purchase_channel       enum-ish text
--   product_received       boolean
--   desired_resolution     text

alter table public.returns
  add column if not exists usage_duration text,
  add column if not exists return_reasons text[] not null default '{}',
  add column if not exists support_contacted text,
  add column if not exists experience_rating int check (experience_rating is null or experience_rating between 1 and 5),
  add column if not exists would_change_decision text,
  add column if not exists future_likelihood text,
  add column if not exists packaging_status text,
  add column if not exists alternative_composting text,
  add column if not exists refund_method_preference text,
  add column if not exists refund_contact text,
  add column if not exists additional_comments text;

-- Widen the condition CHECK to include the granular Jotform options
-- (like-new / good / fair) alongside the legacy values.
alter table public.returns drop constraint if exists returns_condition_check;
alter table public.returns add constraint returns_condition_check
  check (condition is null or condition in (
    'unused', 'used', 'damaged',
    'like-new', 'good', 'fair'
  ));

alter table public.order_cancellations
  add column if not exists preferred_contact text check (preferred_contact is null or preferred_contact in ('email', 'phone')),
  add column if not exists order_date date,
  add column if not exists product_name text,
  add column if not exists order_amount_usd numeric(10,2),
  add column if not exists purchase_channel text,
  add column if not exists product_received boolean,
  add column if not exists desired_resolution text;

-- Update the anon RLS check so customer_form rows can include the new
-- columns (existing policy already allows the insert; this is a no-op
-- expressively reaffirming the contract).
-- (no change needed — WITH CHECK already permits any new columns by default)
