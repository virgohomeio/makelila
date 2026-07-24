-- Notes on a return/refund card while it's still in the pre-refund columns
-- (Return Form Submitted / Return & Inspection). The existing refund_notes are
-- keyed to a refund_approvals row, which doesn't exist yet at intake — so the
-- Account Manager had no way to jot notes on those cards. Mirrors refund_notes
-- (any internal user can add their own note). (Applied to prod via MCP.)

create table if not exists public.return_notes (
  id          uuid primary key default gen_random_uuid(),
  return_id   uuid not null references public.returns(id) on delete cascade,
  body        text not null,
  author_id   uuid default auth.uid(),
  author_name text,
  created_at  timestamptz not null default now()
);

create index if not exists return_notes_return_id_idx on public.return_notes(return_id);

alter table public.return_notes enable row level security;

create policy return_notes_select on public.return_notes
  for select using (public.is_internal_user());
create policy return_notes_insert on public.return_notes
  for insert with check (public.is_internal_user() and author_id = auth.uid());
create policy return_notes_delete on public.return_notes
  for delete using (public.is_internal_user());

alter publication supabase_realtime add table public.return_notes;
