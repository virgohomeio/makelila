-- Store Freightcom's raw shipment status (.state) alongside the internal
-- shipments.status enum, plus the time it was last pulled live.
-- Additive + nullable: no backfill, internal status semantics unchanged.

alter table public.shipments
  add column if not exists freightcom_status text;        -- raw Freightcom .state, verbatim

alter table public.shipments
  add column if not exists status_synced_at  timestamptz; -- last live status pull

comment on column public.shipments.freightcom_status is
  'Raw Freightcom shipment .state (e.g. waiting-for-transit, in-transit). NULL until first live refresh.';
comment on column public.shipments.status_synced_at is
  'Timestamp of the last freightcom-status live pull for this row.';
