-- Shipping-damage claims submitted via the public LILA Shipping Damage Form
-- (/shipping-damage), surfaced in Fulfillment → Claims. Anonymous insert is
-- allowed for customer-form submissions (mirrors the returns/service_tickets
-- public-form pattern).

create table if not exists public.shipping_damage_claims (
  id              uuid primary key default gen_random_uuid(),
  claim_ref       text,
  customer_name   text not null,
  customer_email  text,
  customer_phone  text,
  tracking_number text not null,
  description     text not null,
  status          text not null default 'submitted',
  source          text not null default 'customer_form',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
alter table public.shipping_damage_claims enable row level security;
create policy "claims_select"      on public.shipping_damage_claims for select to authenticated using (true);
create policy "claims_insert_auth" on public.shipping_damage_claims for insert to authenticated with check (true);
create policy "claims_insert_anon" on public.shipping_damage_claims for insert to anon
  with check (source = 'customer_form' and status = 'submitted');
create policy "claims_update"      on public.shipping_damage_claims for update to authenticated using (true) with check (true);

create table if not exists public.shipping_damage_claim_photos (
  id          uuid primary key default gen_random_uuid(),
  claim_id    uuid not null references public.shipping_damage_claims(id) on delete cascade,
  file_path   text not null,
  file_name   text,
  mime_type   text,
  size_bytes  integer,
  created_at  timestamptz not null default now()
);
create index if not exists idx_claim_photos_claim on public.shipping_damage_claim_photos (claim_id);
alter table public.shipping_damage_claim_photos enable row level security;
create policy "claim_photos_select"      on public.shipping_damage_claim_photos for select to authenticated using (true);
create policy "claim_photos_insert_auth" on public.shipping_damage_claim_photos for insert to authenticated with check (true);
create policy "claim_photos_insert_anon" on public.shipping_damage_claim_photos for insert to anon with check (true);
