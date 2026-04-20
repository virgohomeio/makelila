-- P50N actually produced 50 units: 40 shipped to Canada (Dec 5 2025) plus
-- 10 retained in China at Dongguan LC for R&D / pre-ship testing. Those
-- 10 serials (241-250) were deleted by the earlier serial-ranges fix
-- (which treated 241-250 as out-of-range noise). Re-create them with a
-- new 'cn-test' status that captures "at CN factory for ongoing testing,
-- never shipped out".

-- 1. Widen the status CHECK constraint to include 'cn-test'.
alter table public.units drop constraint if exists units_status_check;
alter table public.units add constraint units_status_check
  check (status in (
    'in-production','inbound','ca-test','cn-test',
    'ready','reserved','rework',
    'shipped','team-test','scrap','lost'
  ));

-- 2. Insert the 10 P50N CN-test rows. Serials 241-250, location Dongguan.
insert into public.units (serial, batch, status, location, notes)
select
  'LL01-' || lpad(n::text, 11, '0'),
  'P50N',
  'cn-test',
  'Dongguan LC Technology, China',
  'P50N unit retained at Dongguan for R&D and pre-ship testing. Never shipped to Canada.'
from generate_series(241, 250) as n
on conflict (serial) do update
  set batch = 'P50N',
      status = 'cn-test',
      location = 'Dongguan LC Technology, China',
      notes = excluded.notes;

-- 3. Bump the P50N batch size to 50 (40 CA + 10 CN).
update public.batches set unit_count = 50 where id = 'P50N';
