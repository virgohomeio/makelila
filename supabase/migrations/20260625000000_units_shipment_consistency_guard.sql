-- Guard + linter for unit/shipment state drift.
--
-- Incident (2026-06-22): a one-off backfill import tagged
-- backfill_source='fulfillment-20260621' wrote shipping FACTS onto units —
-- shipped_at, tracking_num, carrier, customer_id — straight from the
-- fulfillment sheet, but never performed the STATE TRANSITION those facts
-- imply: units.status stayed 'ready'/'reserved', the fulfillment_queue rows
-- stayed mid-flow, and the shelf slots stayed 'available'. Result: units that
-- had physically shipped to customers still rendered green/pickable on the
-- Fulfillment shelf + queue, while the Customers Directory (which reads the
-- customer link) correctly showed them under the customer. One row, two
-- columns telling different stories. (Affected: LL01-000000003{08,09,15,39},
-- reconciled by hand; LL01-00000000347 had a stale slot only.)
--
-- Root cause: the invariant "a unit's shipped_at can only be stamped as part
-- of shipping it" lived only in app code (lib/fulfillment.ts) and the
-- step-6 trigger (sync_unit_on_fulfillment, 20260420310000), both of which set
-- status='shipped' and shipped_at together. A bulk writer that bypassed that
-- path had nothing stopping it. This migration moves the invariant into the
-- database so the next bad import fails loudly instead of silently.

-- ── 1. Guard: stamping shipped_at requires the row to be 'shipped' ──────────
--
-- We guard the TRANSITION (shipped_at NULL -> NOT NULL), not the steady state,
-- precisely so we don't fire on the legitimate paths:
--   * Normal ship (sync_unit_on_fulfillment): sets status='shipped' AND
--     shipped_at in the same UPDATE -> new.status='shipped' -> passes.
--   * Return/restock (e.g. LL01-00000000019, "… (returned)"): the unit already
--     shipped once, so shipped_at is already set; moving status back to
--     'ready'/'rework' does NOT re-stamp shipped_at -> no transition -> passes.
--   * Backfill-assign of an already-shipped unit (#57, lib/fulfillment.ts):
--     shipped_at already set, status preserved as 'shipped' -> no transition.
-- The only thing this rejects is exactly the import bug: setting shipped_at on
-- a unit whose status is still pre-ship/in-circulation.
--
-- INSERT is intentionally NOT guarded: historical imports of already-returned
-- units legitimately arrive as status='ready' with a backdated shipped_at.
create or replace function public.guard_units_shipment_consistency()
returns trigger
language plpgsql
as $$
begin
  if old.shipped_at is null
     and new.shipped_at is not null
     and new.status is distinct from 'shipped' then
    raise exception
      'unit %: cannot stamp shipped_at while status is ''%''. Set status=''shipped'' in the same write (ship via the fulfillment queue, or set both columns together for a backfill).',
      new.serial, new.status
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists units_guard_shipment_consistency on public.units;
create trigger units_guard_shipment_consistency
  before update of shipped_at, status on public.units
  for each row execute function public.guard_units_shipment_consistency();

-- ── 2. Linter: a read-only view surfacing post-ship sync drift ──────────────
--
-- The guard above prevents the primary write vector (stamping shipped_at
-- without shipping) going forward; this view is the belt-and-suspenders
-- detector for drift the guard can't see. Query it on a schedule or in CI
-- against a snapshot — a non-empty result is a bug:
--   SELECT * FROM units_shipment_consistency_issues;
--
-- Deliberately scoped to the two UNAMBIGUOUS invariants of a shipped unit:
--   stale_shelf_slot – status='shipped' but the shelf slot isn't 'empty'
--                      (e.g. LL01-00000000347 in the incident)
--   stuck_queue_row  – status='shipped' but an open (step<6) queue row remains
--                      (e.g. LL01-000000003{08,42} in the incident)
--
-- We intentionally do NOT flag "shipped_at set but status is ready/reserved":
-- that is a legitimate resting state for a returned/refurbished unit
-- (shipped -> returned -> restocked to ready, or re-reserved for resale; e.g.
-- LL01-00000000019). The import that caused the incident is blocked at write
-- time by the guard, so it never reaches this view in the first place.
create or replace view public.units_shipment_consistency_issues as
  select 'stale_shelf_slot'::text as issue,
         u.serial,
         u.status        as unit_status,
         u.shipped_at,
         u.backfill_source,
         ss.skid || '/' || ss.slot_index || ' = ' || ss.status as detail
    from public.units u
    join public.shelf_slots ss on ss.serial = u.serial
   where u.status = 'shipped'
     and ss.status <> 'empty'
  union all
  select 'stuck_queue_row',
         u.serial, u.status, u.shipped_at, u.backfill_source,
         'queue ' || fq.id::text || ' at step ' || fq.step::text
    from public.units u
    join public.fulfillment_queue fq on fq.assigned_serial = u.serial
   where u.status = 'shipped'
     and fq.step < 6;

comment on view public.units_shipment_consistency_issues is
  'Drift detector for unit shipment state (incident 2026-06-22). Non-empty = bug. See migration 20260625000000.';
