-- Timestamped notes log per customer (Service → Follow-Ups detail panel).
create table if not exists public.customer_notes (
  id          uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  body        text not null,
  author_id   uuid,
  created_at  timestamptz not null default now()
);
create index if not exists idx_customer_notes_customer on public.customer_notes (customer_id, created_at desc);
alter table public.customer_notes enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='customer_notes' and policyname='internal_only') then
    execute 'create policy internal_only on public.customer_notes using (public.is_internal_user()) with check (public.is_internal_user())';
  end if;
end $$;
