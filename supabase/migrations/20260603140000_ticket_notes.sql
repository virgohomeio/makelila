-- Per-ticket notes log: timestamped, editable note entries that replace the
-- single `service_tickets.internal_notes` scratch field. Cascade-deletes with
-- the ticket and is realtime-enabled so the detail panel updates live.

create table if not exists public.ticket_notes (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references public.service_tickets(id) on delete cascade,
  body text not null,
  author_id uuid references auth.users(id) on delete set null,
  author_email text,                          -- denormalized for display
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_ticket_notes_ticket on public.ticket_notes (ticket_id, created_at);

alter table public.ticket_notes enable row level security;
create policy "ticket_notes_select" on public.ticket_notes for select to authenticated using (true);
create policy "ticket_notes_insert" on public.ticket_notes for insert to authenticated with check (true);
create policy "ticket_notes_update" on public.ticket_notes for update to authenticated using (true) with check (true);

-- Bump updated_at on every edit so the UI can flag "(edited)".
create or replace function public.ticket_notes_touch() returns trigger
  language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists ticket_notes_touch on public.ticket_notes;
create trigger ticket_notes_touch before update on public.ticket_notes
  for each row execute function public.ticket_notes_touch();

alter publication supabase_realtime add table public.ticket_notes;

-- Seed the log from any existing internal_notes so nothing is lost. The column
-- is kept (not dropped) but is no longer surfaced in the UI.
insert into public.ticket_notes (ticket_id, body, created_at, updated_at)
select id, internal_notes, coalesce(updated_at, now()), coalesce(updated_at, now())
from public.service_tickets
where internal_notes is not null and length(trim(internal_notes)) > 0;
