-- Alpha P2 #5 (Junaid): Machine-Level QC tracking on units.
-- Replaces the Feishu spreadsheet. Three-state checks differentiate
-- 'incomplete' from 'fail' (Feishu's tick box could not).

create type qc_check as enum ('pass', 'fail', 'incomplete');

alter table public.units
  add column if not exists technician       text,
  add column if not exists electrical_check qc_check,
  add column if not exists mechanical_check qc_check,
  add column if not exists defect_notes     text;
