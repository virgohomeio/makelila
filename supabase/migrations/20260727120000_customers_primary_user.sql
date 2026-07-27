-- FR-6: the PRIMARY USER of a customer's machine, when different from the
-- purchaser / account holder (e.g. Chad Lockhart bought it; his wife Sarah is
-- the primary user we support). Free-text rather than a customer FK because the
-- primary user is usually not a customer of record (no order under their name).
-- Set on the owner's customer record; surfaced on the refund card. (Applied to
-- prod via MCP.)
alter table public.customers
  add column if not exists primary_user_name  text,
  add column if not exists primary_user_email text;

comment on column public.customers.primary_user_name is
  'FR-6: primary user of this customer''s machine (e.g. spouse) when different from the purchaser. Shown on the refund card.';
comment on column public.customers.primary_user_email is
  'FR-6: optional contact email for the primary user of the machine.';
