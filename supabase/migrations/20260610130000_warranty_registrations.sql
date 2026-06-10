-- Warranty Registration entity (Feature J1).
-- One row per physical unit shipped. coverage_end is DB-computed from
-- coverage_tier so it stays consistent even if the tier is updated.
--
-- coverage_tier values:
--   standard_1y             → +1 year from coverage_start
--   extended_2y             → +2 years from coverage_start
--   replacement_no_warranty → same day (coverage_start = coverage_end)
--   lifetime_legacy         → pinned to 9999-12-31 (P50/P150 good-will units)

create table public.warranty_registrations (
  id uuid primary key default gen_random_uuid(),
  unit_serial text not null unique references public.units(serial),
  customer_id uuid not null references public.customers(id),
  original_order_id uuid references public.orders(id),
  coverage_tier text not null default 'standard_1y'
    check (coverage_tier in ('standard_1y', 'extended_2y', 'replacement_no_warranty', 'lifetime_legacy')),
  coverage_start date not null,
  coverage_end date generated always as (
    case coverage_tier
      when 'standard_1y'              then coverage_start + interval '1 year'
      when 'extended_2y'              then coverage_start + interval '2 year'
      when 'replacement_no_warranty'  then coverage_start
      when 'lifetime_legacy'          then date '9999-12-31'
    end
  ) stored,
  parent_registration_id uuid references public.warranty_registrations(id),
  voided_reason text,
  voided_at timestamptz,
  registered_at timestamptz not null default now(),
  registered_by uuid references auth.users(id)
);

create index on public.warranty_registrations (customer_id);
create index on public.warranty_registrations (original_order_id);
create index on public.warranty_registrations (parent_registration_id);

alter table public.warranty_registrations enable row level security;
create policy "warranty_reg_select" on public.warranty_registrations
  for select to authenticated using (public.is_internal_user());
create policy "warranty_reg_insert" on public.warranty_registrations
  for insert to authenticated with check (public.is_internal_user());
create policy "warranty_reg_update" on public.warranty_registrations
  for update to authenticated
  using (public.is_internal_user()) with check (public.is_internal_user());
