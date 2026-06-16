-- activity_log entity refs substrate (Huayi P2 S — Phase B of the substrate week).
-- See docs/session-notes/huayi.md §Feature 2.
--
-- Today `activity_log` has a free-text `entity` column populated by every
-- logAction(type, entity, detail) call. Per-serial / per-order queries
-- (Junaid's UnitTimeline.tsx, Reina's OKR rollups) currently require
-- text-pattern matching across `entity` + `detail`, which doesn't
-- index cleanly and risks silent drift as detail strings change.
--
-- Add typed columns so those queries are index scans:
--   entity_type  — enum (order/unit/return/ticket/build_station_pass/
--                  depot_repair/warranty_registration/customer/parts_kit_shipment)
--   entity_id    — uuid for orders/returns/tickets/customers (table PKs are uuid)
--   unit_serial  — text for unit lookups (units key on serial text, not uuid;
--                  using a denormalized column is faster than an FK join
--                  + survives serial-renaming + matches existing
--                  units.customer_name pattern in the codebase)
--
-- All three columns nullable — existing logAction call sites stay working
-- without modification. The lib signature gains an optional 4th arg in
-- a follow-up commit; calls opt in module-by-module as their owners
-- update them. NO BACKFILL: historical rows render without entity
-- badges, documented as acceptable.
--
-- Forward-only. Tiny table (312 rows / 152 kB at migration time), so
-- regular CREATE INDEX is instant and acquires only a brief ACCESS
-- EXCLUSIVE for the catalog update — no CONCURRENTLY ceremony needed
-- until volume grows ~100x.

-- 1. Enum.
create type public.activity_entity_type as enum (
  'order',
  'unit',
  'return',
  'ticket',
  'build_station_pass',
  'depot_repair',
  'warranty_registration',
  'customer',
  'parts_kit_shipment'
);

-- 2. Nullable columns.
alter table public.activity_log
  add column entity_type  public.activity_entity_type,
  add column entity_id    uuid,
  add column unit_serial  text;

-- 3. Partial indexes so empty/legacy rows don't bloat the index.
create index if not exists idx_activity_log_entity
  on public.activity_log (entity_type, entity_id, ts desc)
  where entity_type is not null;

create index if not exists idx_activity_log_unit_serial
  on public.activity_log (unit_serial, ts desc)
  where unit_serial is not null;

-- 4. Comments for future readers.
comment on column public.activity_log.entity_type is
  'Typed entity classifier. Pair with entity_id for orders/returns/tickets/customers; pair with unit_serial for unit-scoped rows. Nullable for legacy + non-entity-scoped events (e.g. user_logged_in).';
comment on column public.activity_log.entity_id is
  'UUID PK of the referenced row when entity_type is one of order/return/ticket/customer/etc. Null when the entity is keyed on serial (use unit_serial instead) or when the event has no entity.';
comment on column public.activity_log.unit_serial is
  'Denormalized unit serial for unit-scoped events. Faster than an FK join and survives serial-renaming. Pair with entity_type=''unit'' or use standalone for cross-cutting unit lookups.';
