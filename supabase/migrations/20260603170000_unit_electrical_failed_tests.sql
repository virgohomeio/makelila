-- Failed test names parsed from the uploaded electrical report, surfaced in the
-- Stock Units "Notes" column (e.g. 'Left Motor, Right Motor').
alter table public.units
  add column if not exists electrical_failed_tests text;
