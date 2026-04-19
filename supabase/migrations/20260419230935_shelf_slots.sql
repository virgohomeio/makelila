-- shelf_slots: 150 fixed physical positions (30 skids × 5 slots).
-- Slot-index convention: 0,1,2 = top row (portrait), 3,4 = bottom row (landscape).
create table if not exists public.shelf_slots (
  skid       text not null,
  slot_index smallint not null check (slot_index between 0 and 4),
  serial     text unique,
  batch      text,
  status     text not null default 'empty'
             check (status in ('available','reserved','rework','empty')),
  updated_at timestamptz not null default now(),
  primary key (skid, slot_index)
);

create index if not exists idx_shelf_slots_status on public.shelf_slots (status);

alter table public.shelf_slots enable row level security;

create policy "shelf_slots_select"
  on public.shelf_slots for select
  to authenticated
  using (true);

create policy "shelf_slots_update"
  on public.shelf_slots for update
  to authenticated
  using (true)
  with check (true);

alter publication supabase_realtime add table public.shelf_slots;
