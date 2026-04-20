-- Non-house addresses (apt/condo/remote) require a sales-team confirmation that the
-- LILA Pro will fit at the customer's location before Order Review allows Confirm.
-- Setting this flag records that sales has reached out and confirmed fit.
alter table public.orders
  add column if not exists sales_confirmed_fit boolean not null default false;
