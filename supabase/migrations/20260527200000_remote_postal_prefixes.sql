-- Remote postal prefix table — closes Alpha P1 #1 follow-up + meeting-derived
-- "auto-flag remote orders". Orders whose postal_code matches a seeded prefix
-- get auto-flagged at sync time.
--
-- Match logic: orders.postal_code LIKE prefix || '%'
--
-- Path A seed: universally-remote zones (territories + non-contiguous US).
-- Path B (operator-observed): appended over time as we see surcharges on
-- specific postals. See `source` column.

create table if not exists public.remote_postal_prefixes (
  prefix text primary key,
  country text not null check (country in ('US','CA','OTHER')),
  region text,
  reason text,
  source text not null default 'seeded' check (source in ('seeded','observed','manual')),
  created_at timestamptz not null default now()
);

comment on table public.remote_postal_prefixes is
  'Postal-code prefixes that trigger orders.status=flagged at sync time. Match is postal_code LIKE prefix || ''%''. Path A seed (territories + non-contiguous US) was committed 2026-05-27; Path B (operator-observed) gets appended over time.';

insert into public.remote_postal_prefixes (prefix, country, region, reason, source) values
  ('Y',    'CA', 'Yukon',                    'Territory — carriers surcharge', 'seeded'),
  ('X0A',  'CA', 'Nunavut',                  'Territory — carriers surcharge', 'seeded'),
  ('X0B',  'CA', 'Nunavut',                  'Territory — carriers surcharge', 'seeded'),
  ('X0C',  'CA', 'Nunavut',                  'Territory — carriers surcharge', 'seeded'),
  ('X0E',  'CA', 'Northwest Territories',    'Territory — carriers surcharge', 'seeded'),
  ('X0G',  'CA', 'Northwest Territories',    'Territory — carriers surcharge', 'seeded'),
  ('X1A',  'CA', 'NWT (Yellowknife area)',   'Territory — carriers surcharge', 'seeded'),
  ('A0P',  'CA', 'Labrador',                 'Remote — Labrador coast',        'seeded'),
  ('A0K',  'CA', 'Newfoundland (rural)',     'Rural NL — surcharge zone',      'seeded'),
  ('A2V',  'CA', 'Labrador City',            'Remote — Labrador',              'seeded'),
  ('T0G',  'CA', 'Northern Alberta',         'Rural far-north Alberta',        'seeded'),
  ('T0H',  'CA', 'Northern Alberta',         'Rural far-north Alberta',        'seeded'),
  ('R0B',  'CA', 'Northern Manitoba',        'Rural northern Manitoba',        'seeded'),
  ('V0C',  'CA', 'Northern BC',              'Rural northern BC',              'seeded'),
  ('995',  'US', 'Alaska',                   'Non-contiguous — UPS/USPS surcharge', 'seeded'),
  ('996',  'US', 'Alaska',                   'Non-contiguous — UPS/USPS surcharge', 'seeded'),
  ('997',  'US', 'Alaska',                   'Non-contiguous — UPS/USPS surcharge', 'seeded'),
  ('998',  'US', 'Alaska',                   'Non-contiguous — UPS/USPS surcharge', 'seeded'),
  ('999',  'US', 'Alaska',                   'Non-contiguous — UPS/USPS surcharge', 'seeded'),
  ('967',  'US', 'Hawaii',                   'Non-contiguous — UPS/USPS surcharge', 'seeded'),
  ('968',  'US', 'Hawaii',                   'Non-contiguous — UPS/USPS surcharge', 'seeded'),
  ('006',  'US', 'Puerto Rico',              'US territory — surcharge',       'seeded'),
  ('007',  'US', 'Puerto Rico',              'US territory — surcharge',       'seeded'),
  ('008',  'US', 'US Virgin Islands',        'US territory — surcharge',       'seeded'),
  ('009',  'US', 'Puerto Rico',              'US territory — surcharge',       'seeded'),
  ('969',  'US', 'Guam/NMI/Samoa',           'US territory — surcharge',       'seeded')
on conflict (prefix) do nothing;

alter table public.remote_postal_prefixes enable row level security;
create policy "remote_postal_prefixes_read"   on public.remote_postal_prefixes for select to authenticated using (true);
create policy "remote_postal_prefixes_write"  on public.remote_postal_prefixes for insert to authenticated with check (true);
create policy "remote_postal_prefixes_update" on public.remote_postal_prefixes for update to authenticated using (true) with check (true);
create policy "remote_postal_prefixes_delete" on public.remote_postal_prefixes for delete to authenticated using (true);
