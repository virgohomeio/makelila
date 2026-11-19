-- ESP32 MAC parsed from the uploaded electrical test report (lib/testReports.ts
-- uploadTestReports) or typed into the Stock QC modal. Stored normalised as
-- lowercase "xx:xx:xx:xx:xx:xx".
--
-- Deliberately NOT unique: a board salvaged from a scrapped unit may
-- legitimately reappear in another, and the operator clears the old unit's
-- MAC by hand. Duplicate detection is derived in the app from the loaded units
-- list (lib/stock.ts findMacDuplicates), so there is no flag column to go stale.
alter table public.units
  add column if not exists mac_address text;

create index if not exists idx_units_mac_address
  on public.units (mac_address)
  where mac_address is not null;
