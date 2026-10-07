-- Other users in the household.
--
-- customers.primary_user_* already covers ONE person who uses the machine when
-- that isn't the purchaser. But a household often has more than one: the
-- purchaser stays the primary user and a spouse/child/roommate is also someone
-- we end up in contact with. Those contacts need to be on the record too.
--
-- A child table rather than more secondary_user_* columns because the count is
-- open-ended. These people are usually NOT customers of record (no orders, no
-- accounting identity), so this is free text, not a customers row + purchaser_id
-- link — that link stays reserved for people who actually transact.

create table if not exists public.customer_additional_users (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  -- The only required field: a contact with no name is not a record worth keeping.
  full_name text not null,
  phone text,
  email text,
  -- How they relate to the purchaser. Text, not an enum, for the same reason as
  -- customers.primary_user_relationship: the UI picklist
  -- (PRIMARY_USER_RELATIONSHIPS) has an "Other…" free-text escape, and the list
  -- can grow without a migration.
  relationship text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.customer_additional_users is
  'Other people in a customer''s household who also use the machine, beyond customers.primary_user_*. Free text — these are contacts, not customers of record. Cascades with the customer.';

-- Sole access path is "all household users for this customer, oldest first".
create index if not exists customer_additional_users_customer_idx
  on public.customer_additional_users (customer_id, created_at);

alter table public.customer_additional_users enable row level security;

-- Internal-only app: every authenticated operator sees and edits every customer,
-- same posture as public.customers itself.
drop policy if exists "customer_additional_users_select" on public.customer_additional_users;
create policy "customer_additional_users_select" on public.customer_additional_users
  for select to authenticated using (true);

drop policy if exists "customer_additional_users_insert" on public.customer_additional_users;
create policy "customer_additional_users_insert" on public.customer_additional_users
  for insert to authenticated with check (true);

drop policy if exists "customer_additional_users_update" on public.customer_additional_users;
create policy "customer_additional_users_update" on public.customer_additional_users
  for update to authenticated using (true) with check (true);

drop policy if exists "customer_additional_users_delete" on public.customer_additional_users;
create policy "customer_additional_users_delete" on public.customer_additional_users
  for delete to authenticated using (true);

-- Two operators can have the same customer panel open; realtime keeps the list
-- in sync the way it does for customers.
do $$
begin
  alter publication supabase_realtime add table public.customer_additional_users;
exception
  when duplicate_object then null;
end $$;

drop trigger if exists customer_additional_users_touch on public.customer_additional_users;
create trigger customer_additional_users_touch
  before update on public.customer_additional_users
  for each row execute function public.touch_customers_updated_at();
