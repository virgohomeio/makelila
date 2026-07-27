-- supabase/migrations/20260724130100_hiring_resumes_bucket.sql
--
-- hiring-resumes bucket for uploaded candidate resumes. Private (no public
-- read); the app reads via signed URLs. Mirrors claim-photos bucket
-- (20260622120100) but authenticated-write only — resumes never arrive
-- from an anonymous/public form the way shipping-damage claim photos do.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'hiring-resumes',
  'hiring-resumes',
  false,
  10485760, -- 10 MB
  array['application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document']
)
on conflict (id) do update set
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create policy "hiring_resumes_read_auth" on storage.objects
  for select to authenticated
  using (bucket_id = 'hiring-resumes');

create policy "hiring_resumes_write_auth" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'hiring-resumes');
