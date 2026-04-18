-- Append-only review notes on orders. Each save is a new row.
create table if not exists public.order_notes (
  id            bigserial primary key,
  order_id      uuid not null references public.orders(id) on delete cascade,
  author_id     uuid not null references auth.users(id),
  author_name   text not null,
  body          text not null,
  created_at    timestamptz not null default now()
);

create index if not exists idx_order_notes_order_ts
  on public.order_notes (order_id, created_at desc);

alter table public.order_notes enable row level security;

create policy "order_notes_select"
  on public.order_notes for select
  to authenticated
  using (true);

create policy "order_notes_insert"
  on public.order_notes for insert
  to authenticated
  with check (author_id = auth.uid());

alter publication supabase_realtime add table public.order_notes;

-- orders.notes becomes dead now that notes live in order_notes.
alter table public.orders drop column notes;
