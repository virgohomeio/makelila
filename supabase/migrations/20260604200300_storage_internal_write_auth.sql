-- Security pass Phase 4 follow-up: tighten the authenticated read+write
-- storage policies to require is_internal_user(). Without this, a
-- non-internal authenticated session (e.g. a fresh Google signup that
-- somehow bypasses the React shell) could still upload to / read from
-- the bucket even after Phase 2's RLS rewrite blocks them from every
-- operational table.
--
-- Applied to production via MCP at deploy time; this file is the
-- source-of-truth record.

drop policy if exists "ticket_attachments_write_auth" on storage.objects;
create policy "ticket_attachments_write_auth" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'ticket-attachments'
    and public.is_internal_user()
  );

drop policy if exists "ticket_attachments_read_auth" on storage.objects;
create policy "ticket_attachments_read_auth" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'ticket-attachments'
    and public.is_internal_user()
  );
