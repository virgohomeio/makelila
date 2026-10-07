-- Close replacement_queue rows that are still 'queued' even though the
-- replacement physically shipped.
--
-- BACKGROUND
-- replacement_queue has no FK to units — only a free-text assigned_serial that
-- an operator fills in by hand. Nothing in the fulfilment/shipping path writes
-- back to it, so a row stays 'queued' forever once its unit goes out. On
-- 2026-06-22 a bulk import added a fresh, correct set of rows without
-- retiring the 2026-04-21 originals, leaving two kinds of stale row.
--
-- SCOPE: 4 rows. Everything else in the queue is deliberately left alone —
-- the ambiguous cases (Camp Jubilee x3, Chad Lockhart, and the rest of the
-- 2026-06-22 cohort) need a human decision and are listed in the notice at
-- the end of this migration rather than being guessed at here.
--
-- Idempotent: every statement is guarded on status = 'queued'.

BEGIN;

-- ---------------------------------------------------------------------------
-- CLASS A — duplicate rows (3)
-- The 2026-06-22 import created a correct 'shipped' row for these customers.
-- The 2026-04-21 row is an orphaned duplicate of the SAME replacement, so it
-- is closed rather than marked shipped: marking it shipped would double-count
-- one physical replacement as two in every downstream rollup (warranty
-- reserve, profitability, the production projection's replacement_queue_size).
-- ---------------------------------------------------------------------------

UPDATE replacement_queue q
   SET status     = 'closed',
       notes      = coalesce(q.notes || E'\n', '')
                    || '[backfill 2026-08-18] Duplicate of ' || s.id
                    || ' (shipped, serial ' || coalesce(s.assigned_serial, 'unknown')
                    || '). Closed — the replacement shipped once; this row was the '
                    || 'un-retired 2026-04-21 original.',
       updated_at = now()
  FROM replacement_queue s
 WHERE q.status = 'queued'
   AND s.status = 'shipped'
   AND lower(trim(s.customer_name)) = lower(trim(q.customer_name))
   AND q.id IN (
     '43fe4eb8-1e32-4635-8aeb-9608dab6eb0b',  -- Chris & Renata Grant  → twin d00cc2aa (LL01-00000000288)
     '4bde74e8-e17f-46e3-aa01-865f0a0bb075',  -- Jeffrey Van Dyke      → twin 557328b0 (LL01-00000000304)
     'dcb331a6-e6f8-486e-ad4b-743b591c5a3d'   -- Kevin Cheng           → twin 318dc262 (LL01-00000000341)
   );

-- ---------------------------------------------------------------------------
-- CLASS B — genuinely un-closed (1)
-- Cheryl Lemieux has no duplicate row. Her replacement LL01-00000000317
-- shipped 2026-05-06 under replacement order ref R-0032; her original
-- LL01-00000000091 came back to us and sits in 'rework'. This row is the
-- real record of that replacement, so it is completed in place.
-- ---------------------------------------------------------------------------

UPDATE replacement_queue
   SET status          = 'shipped',
       assigned_serial = 'LL01-00000000317',
       notes           = coalesce(notes || E'\n', '')
                         || '[backfill 2026-08-18] Shipped 2026-05-06 as replacement '
                         || 'order R-0032. Original LL01-00000000091 returned, now in rework.',
       updated_at      = now()
 WHERE id = 'cddb587a-af17-4d46-b80e-4fa02a8f62a9'
   AND status = 'queued';

-- ---------------------------------------------------------------------------
-- Verification + the deliberately-untouched list.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  v_closed  int;
  v_shipped int;
  v_left    int;
BEGIN
  SELECT count(*) INTO v_closed  FROM replacement_queue
   WHERE status = 'closed'  AND notes LIKE '%[backfill 2026-08-18]%';
  SELECT count(*) INTO v_shipped FROM replacement_queue
   WHERE status = 'shipped' AND notes LIKE '%[backfill 2026-08-18]%';
  SELECT count(*) INTO v_left    FROM replacement_queue WHERE status = 'queued';

  RAISE NOTICE 'replacement_queue backfill: % closed as duplicates, % completed. % still queued.',
    v_closed, v_shipped, v_left;

  IF v_closed <> 3 OR v_shipped <> 1 THEN
    RAISE EXCEPTION 'Expected 3 closed + 1 shipped, got % + %. Rolling back.', v_closed, v_shipped;
  END IF;

  RAISE NOTICE 'NOT touched — these need a human decision:';
  RAISE NOTICE '  Camp Jubilee / David Duckworth (#1,#2,#3): 3 queue rows but only ONE';
  RAISE NOTICE '    shipped unit (LL01-00000000311, 2026-04-22). One is fulfilled, two are';
  RAISE NOTICE '    genuinely waiting — the data cannot say which.';
  RAISE NOTICE '  Chad Lockhart: LL01-00000000265 has status=shipped and tracking P37735106';
  RAISE NOTICE '    but shipped_at is NULL, so it fails every date test. Probably fulfilled.';
  RAISE NOTICE '  The 2026-06-22 cohort (Jacob Wenger, Shearries Lafontaine, Jeff Carnahan,';
  RAISE NOTICE '    Patrick Taylor, Angeline Purcell, ...): created_at is the bulk-import date,';
  RAISE NOTICE '    not the request date, so "unit shipped after queueing" is meaningless there.';
END $$;

COMMIT;
