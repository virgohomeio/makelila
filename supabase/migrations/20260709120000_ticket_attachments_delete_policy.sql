-- Backfill the missing DELETE policies for ticket attachments.
--
-- service_ticket_attachments had INSERT + SELECT policies but no DELETE, and
-- the ticket-attachments storage bucket had INSERT + SELECT but no DELETE. With
-- RLS on and no DELETE policy, deletes are SILENTLY denied (0 rows, no error),
-- so removing a pasted/uploaded image from a support ticket appeared to succeed
-- but the row (and file) stayed — the image reappeared on refresh.
--
-- Scoped to internal users, mirroring the existing *_auth read/write policies.

-- 1. The DB row
drop policy if exists "attachments_delete" on public.service_ticket_attachments;
create policy "attachments_delete" on public.service_ticket_attachments
  for delete to authenticated
  using (public.is_internal_user());

-- 2. The stored file
drop policy if exists "ticket_attachments_delete_auth" on storage.objects;
create policy "ticket_attachments_delete_auth" on storage.objects
  for delete to authenticated
  using (bucket_id = 'ticket-attachments' and public.is_internal_user());
