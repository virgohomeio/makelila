-- activity_log: UX-layer audit stream (distinct from row-level audit_log)
create table if not exists public.activity_log (
  id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  ts timestamptz not null default now(),
  type text not null,
  entity text not null,
  detail text default ''
);

create index if not exists idx_activity_log_ts
  on public.activity_log (ts desc);
create index if not exists idx_activity_log_user_ts
  on public.activity_log (user_id, ts desc);

-- RLS: all authenticated users read all entries; insert stamps current user
alter table public.activity_log enable row level security;

create policy "activity_log_select_all_authenticated"
  on public.activity_log for select
  to authenticated
  using (true);

create policy "activity_log_insert_self"
  on public.activity_log for insert
  to authenticated
  with check (auth.uid() = user_id);

-- Enable realtime for this table
alter publication supabase_realtime add table public.activity_log;
