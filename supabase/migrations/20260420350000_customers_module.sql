-- Customers module: source-of-truth contact records pulled from HubSpot.
--
-- Why a separate table from orders:
--   - Orders is per-purchase (one row per Shopify order ref).
--   - Customers is the persistent contact record across multiple orders,
--     replacement shipments, returns, etc. Service team picks from this
--     list when shipping a part / arranging a replacement.
--
-- HubSpot is the system of record (CRM) for contact info; we cache it
-- here so the UI is fast and works offline-of-HubSpot. The
-- sync-hubspot-customers edge function pulls the latest on demand.

create table if not exists public.customers (
  id uuid primary key default gen_random_uuid(),
  hubspot_id text unique,                   -- HubSpot contact id (numeric string)
  email text unique,
  first_name text,
  last_name text,
  full_name text generated always as (
    trim(coalesce(first_name, '') || ' ' || coalesce(last_name, ''))
  ) stored,
  phone text,
  address_line text,
  city text,
  region text,                              -- state / province code (e.g. ON, CA)
  postal_code text,
  country text,                             -- 2-letter ISO (CA, US, ...)
  notes text,
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_customers_email on public.customers (lower(email));
create index if not exists idx_customers_name  on public.customers (lower(full_name));

alter table public.customers enable row level security;
create policy "customers_select" on public.customers for select to authenticated using (true);
create policy "customers_insert" on public.customers for insert to authenticated with check (true);
create policy "customers_update" on public.customers for update to authenticated using (true) with check (true);

alter publication supabase_realtime add table public.customers;

create or replace function public.touch_customers_updated_at() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;

drop trigger if exists customers_touch on public.customers;
create trigger customers_touch before update on public.customers
  for each row execute function public.touch_customers_updated_at();

-- Add a soft FK from part_shipments to customers so the picker can link
-- a shipment to a known customer record. Existing customer_name text
-- column is preserved for free-text fallback / historical rows.
alter table public.part_shipments
  add column if not exists customer_id uuid references public.customers(id) on delete set null;

create index if not exists idx_partshipments_customer on public.part_shipments (customer_id);
