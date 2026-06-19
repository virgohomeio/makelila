-- Operator-added follow-up action items (a checklist per customer in Service → Follow-Ups).
create table if not exists public.customer_action_items (
  id          uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  text        text not null,
  due_date    date,
  done        boolean not null default false,
  done_at     timestamptz,
  created_by  uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists idx_action_items_customer on public.customer_action_items (customer_id);
alter table public.customer_action_items enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='customer_action_items' and policyname='internal_only') then
    execute 'create policy internal_only on public.customer_action_items using (public.is_internal_user()) with check (public.is_internal_user())';
  end if;
end $$;
