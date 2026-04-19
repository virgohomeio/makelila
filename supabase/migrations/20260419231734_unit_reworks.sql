-- unit_reworks: audit log of flagged-for-rework units.
create table if not exists public.unit_reworks (
  id bigserial primary key,
  serial text not null,
  skid text,
  slot_index smallint,
  order_id uuid references public.orders(id),
  issue text not null,
  flagged_by uuid not null references auth.users(id),
  flagged_by_name text not null,
  flagged_at timestamptz not null default now(),
  resolved_by uuid references auth.users(id),
  resolved_by_name text,
  resolved_at timestamptz,
  resolution_notes text
);

create index if not exists idx_unit_reworks_open
  on public.unit_reworks (flagged_at desc)
  where resolved_at is null;

alter table public.unit_reworks enable row level security;

create policy "unit_reworks_select"
  on public.unit_reworks for select
  to authenticated using (true);

create policy "unit_reworks_insert"
  on public.unit_reworks for insert
  to authenticated with check (flagged_by = auth.uid());

create policy "unit_reworks_update"
  on public.unit_reworks for update
  to authenticated using (true) with check (true);

alter publication supabase_realtime add table public.unit_reworks;
