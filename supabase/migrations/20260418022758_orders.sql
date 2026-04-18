-- orders: triage queue for incoming orders before fulfillment
create table if not exists public.orders (
  id            uuid primary key default gen_random_uuid(),
  order_ref     text unique not null,
  status        text not null default 'pending'
                check (status in ('pending','approved','flagged','held')),

  customer_name  text not null,
  customer_email text,
  customer_phone text,
  quo_thread_url text,

  address_line   text not null,
  city           text not null,
  region_state   text,
  country        text not null check (country in ('US','CA')),
  address_verdict text not null
                  check (address_verdict in ('house','apt','remote','condo')),

  freight_estimate_usd  numeric(10,2) not null,
  freight_threshold_usd numeric(10,2) not null,

  total_usd     numeric(10,2) not null,
  line_items    jsonb not null default '[]'::jsonb,

  notes         text not null default '',
  dispositioned_by uuid references auth.users(id),
  dispositioned_at timestamptz,

  created_at    timestamptz not null default now()
);

create index if not exists idx_orders_status_created
  on public.orders (status, created_at desc);

alter table public.orders enable row level security;

create policy "orders_select"
  on public.orders for select
  to authenticated
  using (true);

create policy "orders_update"
  on public.orders for update
  to authenticated
  using (true);

alter publication supabase_realtime add table public.orders;
