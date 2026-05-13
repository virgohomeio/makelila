-- ticket-attachments bucket for customer-submitted photos/videos and
-- ops-uploaded files. Private; access via signed URLs from the app.
-- Anon INSERT is allowed for customer-form uploads (validated by
-- attachment row INSERT policy which checks parent ticket source).

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'ticket-attachments',
  'ticket-attachments',
  false,
  26214400, -- 25 MB
  array[
    'image/jpeg','image/png','image/webp','image/heic','image/heif',
    'video/mp4','video/quicktime','video/webm'
  ]
)
on conflict (id) do update set
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Read: any authenticated user (ops team)
create policy "ticket_attachments_read_auth" on storage.objects
  for select to authenticated
  using (bucket_id = 'ticket-attachments');

-- Write: authenticated users (ops) anywhere in the bucket
create policy "ticket_attachments_write_auth" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'ticket-attachments');

-- Write: anon users only into a path matching their just-created ticket id.
-- The application uploads to {ticket_id}/{uuid}-{filename} after the ticket
-- has been inserted; the path prefix gates access by enforcing that the
-- first path segment is a valid uuid.
create policy "ticket_attachments_write_anon" on storage.objects
  for insert to anon
  with check (
    bucket_id = 'ticket-attachments'
    and (storage.foldername(name))[1] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  );
