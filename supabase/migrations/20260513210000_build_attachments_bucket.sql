-- build-attachments bucket: IQC defect photos + videos. Private; access via
-- signed URLs from the app. Authenticated team can read+write; no anonymous
-- access (matches the internal-only nature of the Build module).

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'build-attachments',
  'build-attachments',
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

create policy "build_attachments_read_auth" on storage.objects
  for select to authenticated
  using (bucket_id = 'build-attachments');

create policy "build_attachments_write_auth" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'build-attachments');

create policy "build_attachments_delete_auth" on storage.objects
  for delete to authenticated
  using (bucket_id = 'build-attachments');
