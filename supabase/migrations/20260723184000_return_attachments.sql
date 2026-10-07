-- FR-14 (Refund & Return Approval PRD §7): multi-photo attachments on a
-- refund/return card (paste-to-attach ported from the ticket tool). Files live
-- in the existing 'return-documents' storage bucket; this table records them so
-- a card can carry several inspection/issue photos, not just the single
-- returns.purchase_proof. Internal-only, mirroring service_ticket_attachments.
-- (Applied to prod via MCP.)

create table if not exists public.return_attachments (
  id          uuid primary key default gen_random_uuid(),
  return_id   uuid not null references public.returns(id) on delete cascade,
  file_path   text not null,
  file_name   text not null,
  mime_type   text,
  size_bytes  bigint,
  uploaded_by uuid default auth.uid(),
  created_at  timestamptz not null default now()
);

create index if not exists return_attachments_return_id_idx on public.return_attachments(return_id);

alter table public.return_attachments enable row level security;

create policy return_attachments_select on public.return_attachments
  for select using (public.is_internal_user());
create policy return_attachments_insert on public.return_attachments
  for insert with check (public.is_internal_user());
create policy return_attachments_delete on public.return_attachments
  for delete using (public.is_internal_user());

alter publication supabase_realtime add table public.return_attachments;
