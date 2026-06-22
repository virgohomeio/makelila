-- claim-photos bucket for customer-submitted shipping-damage photos.
-- Private; access via signed URLs from the app. Anon INSERT allowed into a
-- path whose first segment is the just-created claim's uuid (mirrors the
-- ticket-attachments bucket).

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'claim-photos',
  'claim-photos',
  false,
  26214400, -- 25 MB
  array['image/jpeg','image/png','image/webp','image/heic','image/heif']
)
on conflict (id) do update set
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create policy "claim_photos_read_auth" on storage.objects
  for select to authenticated
  using (bucket_id = 'claim-photos');

create policy "claim_photos_write_auth" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'claim-photos');

create policy "claim_photos_write_anon" on storage.objects
  for insert to anon
  with check (
    bucket_id = 'claim-photos'
    and (storage.foldername(name))[1] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  );
