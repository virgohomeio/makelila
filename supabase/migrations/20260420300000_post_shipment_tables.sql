-- Post-Shipment module tables.
--
-- returns: RMA pipeline. One row per return request. The md's "Returns Log"
--   (32 entries), "Return Pickups via MaxxUs" (8 entries), and "Return
--   Pickups via Canada Fulfillment" (7 entries) all collapse into this table.
--
-- replacement_queue: customers waiting for a replacement unit. Populated
--   from the md's "P100 Replacements Queued" (~17 entries) + the Camp
--   Jubilee x3 priority. Once a serial is assigned, the unit moves through
--   the normal Fulfillment flow.

-- ================================================================
-- returns
-- ================================================================
create table if not exists public.returns (
  id uuid primary key default gen_random_uuid(),
  return_ref text unique,                         -- 'RTN-0001' etc (nullable for MaxxUs pickups w/o RMA#)
  customer_name text not null,
  customer_email text,
  channel text check (channel in ('Canada','USA')),
  unit_serial text,                               -- can't FK — some pickups lack serial data; validate in app
  original_order_ref text,
  condition text check (condition is null or condition in ('unused','used','damaged')),
  reason text,                                    -- 'Product Defect', 'Financing Issue', 'Shipping Damage', 'Software Issue', 'Other'
  refund_amount_usd numeric(10,2),
  status text not null default 'created' check (status in (
    'created','pickup_scheduled','picked_up','received','inspected','refunded','denied','closed'
  )),
  pickup_carrier text,
  pickup_tracking text,
  pickup_date date,
  received_at timestamptz,
  refund_issued_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_returns_status on public.returns (status);
create index if not exists idx_returns_customer on public.returns (customer_name);

alter table public.returns enable row level security;
create policy "returns_select" on public.returns for select to authenticated using (true);
create policy "returns_insert" on public.returns for insert to authenticated with check (true);
create policy "returns_update" on public.returns for update to authenticated using (true) with check (true);

alter publication supabase_realtime add table public.returns;

create or replace function public.touch_returns_updated_at() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;

drop trigger if exists returns_touch on public.returns;
create trigger returns_touch before update on public.returns
  for each row execute function public.touch_returns_updated_at();

-- ================================================================
-- replacement_queue
-- ================================================================
create table if not exists public.replacement_queue (
  id uuid primary key default gen_random_uuid(),
  customer_name text not null,
  customer_email text,
  original_unit_serial text,                      -- the unit that failed
  original_order_ref text,
  batch_preference text,                          -- typically 'P100'
  priority boolean not null default false,
  assigned_serial text references public.units(serial) on delete set null,
  status text not null default 'queued' check (status in (
    'queued','assigned','shipped','closed'
  )),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_replqueue_status on public.replacement_queue (status);
create index if not exists idx_replqueue_priority on public.replacement_queue (priority desc, created_at asc);

alter table public.replacement_queue enable row level security;
create policy "replqueue_select" on public.replacement_queue for select to authenticated using (true);
create policy "replqueue_insert" on public.replacement_queue for insert to authenticated with check (true);
create policy "replqueue_update" on public.replacement_queue for update to authenticated using (true) with check (true);

alter publication supabase_realtime add table public.replacement_queue;

drop trigger if exists replqueue_touch on public.replacement_queue;
create trigger replqueue_touch before update on public.replacement_queue
  for each row execute function public.touch_returns_updated_at();

-- ================================================================
-- Seed returns (md Returns Log 2026-04-20, 32 entries)
-- ================================================================
insert into public.returns (return_ref, customer_name, channel, condition, reason, refund_amount_usd, status, pickup_date, notes) values
('RTN-0001','Chezo Nojang',        'USA',   'unused', 'Other',           1040,   'refunded', '2026-03-04', null),
('RTN-0002','Jeannette Sanchez',   'USA',   'unused', 'Other',           1023,   'refunded', '2026-02-03', null),
('RTN-0003','Matthew Miller',      'USA',   'unused', 'Financing Issue', 1020,   'refunded', '2026-02-09', null),
('RTN-0004','Desiree Page',        'USA',   'unused', 'Financing Issue', 1003,   'refunded', '2026-02-07', null),
('RTN-0005','Matthew Lypkie',      'Canada','unused', 'Other',             72,   'refunded', '2026-01-09', 'Canpar D420352470001752666001'),
('RTN-0006','Allen Yi & Jessie Hu','Canada','unused', 'Other',            429,   'refunded',  null,        null),
('RTN-0007','Ruiping Guo',         'Canada','unused', 'Other',            200,   'refunded',  null,        null),
('RTN-0008','Tim Li',              'Canada','unused', 'Other',            403,   'refunded',  null,        null),
('RTN-0009','Jim Ford',            'Canada','unused', 'Other',            859,   'refunded',  null,        null),
('RTN-0010','Lisa Jervis',         'USA',   'unused', 'Financing Issue', 1004,   'refunded', '2026-03-05', null),
('RTN-0011','Kimberley Mayers',    'Canada','unused', 'Other',            200,   'refunded',  null,        null),
('RTN-0012','Prema Vaidyanethen',  'Canada','unused', 'Other',           1068,   'refunded',  null,        null),
('RTN-0013','Marie Kessaris & Sean Li','Canada','damaged','Product Defect',751,  'refunded', '2025-05-22', null),
('RTN-0014','Mike Ferguson',       'Canada','used',   'Other',           1068,   'refunded', '2025-11-21', null),
('RTN-0016','Scott Destephanis',   'Canada','used',   'Software Issue',   751,   'refunded', '2025-01-04', 'Unit serial 108'),
('RTN-0017','Francine Bryant',     'Canada','unused', 'Other',            200,   'refunded',  null,        null),
('RTN-0018','Robert & Mylene Facchini','Canada','used','Product Defect', 1068,   'refunded', '2025-07-09', 'Unit serial 025, refurbished to Matthew Mossey'),
('RTN-0019','Peter Phillips',      'Canada','unused', 'Other',            500,   'refunded',  null,        null),
('RTN-0020','Karen Dubeau',        'Canada','unused', 'Other',             56,   'refunded',  null,        null),
('RTN-0021','Thao Truong',         'Canada','used',   'Product Defect',   551,   'refunded', '2025-06-06', 'Unit serial 004, refurbished to Sharon Corcoran'),
('RTN-0022','Cecilia Lee',         'Canada','used',   'Product Defect',   751,   'refunded', '2025-10-21', 'Unit serial 023, refurbished to Shelley Small'),
('RTN-0023','Ari & Jack',          'Canada','used',   'Product Defect',  1468,   'refunded', '2026-02-07', null),
('RTN-0024','Sharai Mustatia',     'Canada','used',   'Shipping Damage',   51,   'refunded', '2026-02-05', 'Unit serial 043, Canpar D420352470001790865001'),
('RTN-0025','Joseph Le',           'USA',   'unused', 'Other',           1005,   'refunded', '2026-02-16', null),
('RTN-0026','Don Saldana',         'Canada','used',   'Software Issue',  null,   'received', '2026-02-09', 'Unit serial 021, Canpar D420352470001836227001 - refund pending'),
('RTN-0027','Shelley Small',       'Canada','damaged','Shipping Damage',    7,   'refunded', '2026-02-27', 'Unit serial 023, Canpar D556276790000041560001'),
('RTN-0028','Jefy Chacko',         'USA',   'unused', 'Shipping Damage', null,   'received', '2026-03-18', 'Unit serial 238 - refund pending'),
('RTN-0029','Kristi Blue',         'USA',    null,     null,             null,   'created',   null,        'Unit serial 227 - pending assessment'),
('RTN-0030','Chad & Sarah Lockhart','Canada',null,    'Other',           null,   'created',   null,        null),
('RTN-0031','RJ & Katrina Dowd',   'USA',    null,    'Other',            275,   'refunded', '2026-04-13', null),
('RTN-0032','Dale Bober',          'USA',    null,    'Other',            235,   'refunded', '2026-04-10', 'Unit serial 347')
on conflict (return_ref) do nothing;

-- Attach unit_serial for the returns that clearly reference one in the notes.
update public.returns set unit_serial = 'LL01-00000000108' where return_ref = 'RTN-0016';
update public.returns set unit_serial = 'LL01-00000000025' where return_ref = 'RTN-0018';
update public.returns set unit_serial = 'LL01-00000000004' where return_ref = 'RTN-0021';
update public.returns set unit_serial = 'LL01-00000000023' where return_ref = 'RTN-0022';
update public.returns set unit_serial = 'LL01-00000000043' where return_ref = 'RTN-0024';
update public.returns set unit_serial = 'LL01-00000000021' where return_ref = 'RTN-0026';
update public.returns set unit_serial = 'LL01-00000000023' where return_ref = 'RTN-0027';
update public.returns set unit_serial = 'LL01-00000000238' where return_ref = 'RTN-0028';
update public.returns set unit_serial = 'LL01-00000000227' where return_ref = 'RTN-0029';
update public.returns set unit_serial = 'LL01-00000000347' where return_ref = 'RTN-0032';

-- ================================================================
-- Seed replacement_queue (md "P100 Replacements Queued")
-- ================================================================
insert into public.replacement_queue (customer_name, batch_preference, priority, status, notes) values
('Tien Tran',                           'P100', false, 'queued', 'P100 replacement'),
('Salvatore & Julia DeCillis',          'P100', false, 'queued', 'P100'),
('Michael Madigan',                     'P100', false, 'queued', 'P100 replacement'),
('Chad Lockhart',                       'P100', true,  'queued', 'P100, priority'),
('Brian Fryer',                         'P100', false, 'queued', 'P100 replacement'),
('Sharon Corcoran',                     'P100', false, 'queued', 'P100 replacement'),
('Chris & Renata Grant',                'P100', false, 'queued', 'P100 replacement'),
('Tamara Martin',                       'P100', false, 'queued', 'P100 replacement'),
('Candace Chan',                        'P100', false, 'queued', 'P100 replacement'),
('Zhenghe Zhang',                       'P100', false, 'queued', 'P100 replacement'),
('Kevin Cheng',                         'P100', false, 'queued', 'P100 replacement'),
('Kirk Beatty',                         'P100', false, 'queued', 'First machine (P100)'),
('Scott Gilbert & Karolina Chmiel',     'P100', false, 'queued', 'P100 replacement needed'),
('Cheryl Lemieux',                      'P100', false, 'queued', 'P100 replacement machine'),
('Tony Rinella',                        'P100', false, 'queued', 'P100 replacement machine'),
('Jeffrey Van Dyke',                    'P100', false, 'queued', 'P100 replacement'),
('Camp Jubilee / David Duckworth (#1)', 'P100', true,  'queued', 'Priority, 1 of 3 units'),
('Camp Jubilee / David Duckworth (#2)', 'P100', true,  'queued', 'Priority, 2 of 3 units'),
('Camp Jubilee / David Duckworth (#3)', 'P100', true,  'queued', 'Priority, 3 of 3 units')
on conflict do nothing;
