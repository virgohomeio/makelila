-- Extend shipments table to support historical Freightcom data sync.
--
-- The original shipments table (20260619120000_shipments_claims.sql) was
-- designed for forward-going bookings made through makeLILA. P100 batch
-- shipments were booked directly in Freightcom by Raymond Zhu and need to
-- be back-filled from the Freightcom API.
--
-- Changes:
--   1. Make order_id nullable (historical records may not have a clean order match)
--   2. Add unit_serial FK for direct unit linking (tracking number → serial)
--   3. Add origin/destination address fields
--   4. Add package dimensions and weight
--   5. Add financial breakdown (billed vs quoted, surcharges, invoice data)
--   6. Add key event timestamps (picked_up_at, delivered_at, estimated_delivery)
--   7. Add sync metadata (synced_at, raw_payload JSONB)

begin;

-- 1. order_id nullable — historical Freightcom shipments have no makelila order
alter table public.shipments
  alter column order_id drop not null;

-- 2. Direct unit link (nullable — not all shipments map to a single serial)
alter table public.shipments
  add column if not exists unit_serial text references public.units(serial) on delete set null;

-- 3. Origin address
alter table public.shipments
  add column if not exists origin_city         text,
  add column if not exists origin_province     text,
  add column if not exists origin_postal       text,
  add column if not exists origin_country      text default 'CA';

-- 4. Destination address (mirror of what's on the order, denormalized for reporting)
alter table public.shipments
  add column if not exists dest_city           text,
  add column if not exists dest_province       text,
  add column if not exists dest_postal         text,
  add column if not exists dest_country        text default 'CA';

-- 5. Package details
alter table public.shipments
  add column if not exists weight_kg           numeric(8,2),
  add column if not exists dimensions_cm       jsonb;   -- {l, w, h}

-- 6. Financial breakdown (CAD)
alter table public.shipments
  add column if not exists billed_cad            numeric(10,2),
  add column if not exists base_charge_cad       numeric(10,2),
  add column if not exists fuel_surcharge_cad    numeric(10,2),
  add column if not exists residential_surcharge_cad numeric(10,2),
  add column if not exists remote_surcharge_cad  numeric(10,2),
  add column if not exists other_surcharges      jsonb,   -- [{name, amount_cad}]
  add column if not exists invoice_number        text,
  add column if not exists invoice_date          date,
  add column if not exists invoiced_at           timestamptz;

-- 7. Key event timestamps
alter table public.shipments
  add column if not exists picked_up_at          timestamptz,
  add column if not exists estimated_delivery    date,
  add column if not exists delivered_at          timestamptz;

-- 8. Sync metadata
alter table public.shipments
  add column if not exists synced_at             timestamptz default now(),
  add column if not exists raw_payload           jsonb;   -- full Freightcom API response

-- Indexes for common query patterns
create index if not exists shipments_unit_serial_idx
  on public.shipments(unit_serial);

create index if not exists shipments_invoice_number_idx
  on public.shipments(invoice_number);

create index if not exists shipments_status_booked_idx
  on public.shipments(status, booked_at desc);

create index if not exists shipments_tracking_idx
  on public.shipments(primary_tracking_number)
  where primary_tracking_number is not null;

commit;
