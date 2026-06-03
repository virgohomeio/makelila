-- Electrical test-report uploads: link each unit to its .md test-script output
-- (stored in the 'test-reports' Supabase Storage bucket) and reuse the existing
-- units.electrical_check (pass/fail/incomplete) for the parsed result.
alter table public.units
  add column if not exists test_report_path text,
  add column if not exists test_report_name text,
  add column if not exists test_report_uploaded_at timestamptz;

-- Private bucket — reports are sensitive; the app links via short-lived signed URLs.
insert into storage.buckets (id, name, public)
values ('test-reports', 'test-reports', false)
on conflict (id) do nothing;

-- Authenticated users may read + upload test reports.
drop policy if exists "test_reports_read" on storage.objects;
create policy "test_reports_read" on storage.objects
  for select to authenticated using (bucket_id = 'test-reports');

drop policy if exists "test_reports_insert" on storage.objects;
create policy "test_reports_insert" on storage.objects
  for insert to authenticated with check (bucket_id = 'test-reports');
