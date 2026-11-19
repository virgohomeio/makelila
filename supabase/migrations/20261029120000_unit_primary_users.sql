-- Primary user per MACHINE.
--
-- customers.primary_user_* records one primary user per customer. That breaks
-- down when one purchaser buys several machines for different people — e.g.
-- Julia Larway bought 3 units: one for herself and two shipped to other
-- contacts. Each machine needs its own primary user.
--
-- Keyed by unit serial: a machine has at most one primary user. The customer
-- that recorded it is kept so the panel can load "all per-machine users for
-- this customer" in one query, and so the row doesn't silently follow the unit
-- if it's later reassigned (the panel only shows units the customer holds).
-- Free text like customers.primary_user_* — these people are usually not
-- customers of record.

create table if not exists public.unit_primary_users (
  unit_serial text primary key references public.units(serial) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  full_name text not null,
  phone text,
  email text,
  -- How they relate to the purchaser. Text — see PRIMARY_USER_RELATIONSHIPS.
  relationship text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.unit_primary_users is
  'Primary user of one specific machine, when a purchaser holds several units used by different people. Overrides customers.primary_user_* for that serial.';

create index if not exists unit_primary_users_customer_idx
  on public.unit_primary_users (customer_id);

alter table public.unit_primary_users enable row level security;

-- Internal-only app: same posture as customers / customer_additional_users.
drop policy if exists "unit_primary_users_select" on public.unit_primary_users;
create policy "unit_primary_users_select" on public.unit_primary_users
  for select to authenticated using (true);

drop policy if exists "unit_primary_users_insert" on public.unit_primary_users;
create policy "unit_primary_users_insert" on public.unit_primary_users
  for insert to authenticated with check (true);

drop policy if exists "unit_primary_users_update" on public.unit_primary_users;
create policy "unit_primary_users_update" on public.unit_primary_users
  for update to authenticated using (true) with check (true);

drop policy if exists "unit_primary_users_delete" on public.unit_primary_users;
create policy "unit_primary_users_delete" on public.unit_primary_users
  for delete to authenticated using (true);

do $$
begin
  alter publication supabase_realtime add table public.unit_primary_users;
exception
  when duplicate_object then null;
end $$;

drop trigger if exists unit_primary_users_touch on public.unit_primary_users;
create trigger unit_primary_users_touch
  before update on public.unit_primary_users
  for each row execute function public.touch_customers_updated_at();
