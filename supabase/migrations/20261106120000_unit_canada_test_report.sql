-- Second test-report slot per unit. Every unit ships with the China factory
-- test report (the existing test_report_* columns — mandatory); some units are
-- also re-tested in Canada. The Canada report is optional and is attached
-- alongside, never in place of, the China one. Same private 'test-reports'
-- bucket; files may be .md or .pdf.
alter table public.units
  add column if not exists canada_test_report_path text,
  add column if not exists canada_test_report_name text,
  add column if not exists canada_test_report_uploaded_at timestamptz;

comment on column public.units.test_report_path is
  'China factory test report (mandatory for every unit).';
comment on column public.units.canada_test_report_path is
  'Canada test report (optional; only some units are re-tested in Canada).';
