-- Tamara Martin (R-0022) and Brian Fryer (R-0025) are queued for P100X, not
-- P100, and their replacement orders should show the pending unit.
--
-- TWO SEPARATE DEFECTS, both from the same backfilled rows:
--
-- 1. Wrong batch. Both orders carry batch 'P100' in line_items and a NULL
--    awaiting_batch_id, and both replacement_queue rows say batch_preference
--    'P100'. They belong on P100X (projected arrival Sep 2026), alongside
--    Kristen Pimentel R-0001 and Cheryl Lemieux R-0032.
--
-- 2. "No items recorded on this replacement" on the ticket. QueuedReplacement
--    in TicketDetailPanel builds its item chips from `li.name`, and these rows
--    were written as a bare {kind, batch} with NO name key — so the chip list
--    comes out empty. Its fallback ("LILA (<batch>)" from awaiting_batch_id)
--    then can't fire either, because awaiting_batch_id is NULL. Setting both
--    fields fixes the display and the batch at once.
--
-- createPendingReplacement() derives awaiting_batch_id from the pending line
-- item's `batch`, so these rows could only have come from a backfill, not the
-- app. line_items is rewritten to the exact shape the app emits (compare
-- R-0057 Jim Christie, R-0064 Douglas Hanson).
--
-- cogs_usd is already 314.00 on both and matches the P100X unit cost, so it is
-- deliberately left alone.
--
-- Idempotent: guarded on the current wrong values.

BEGIN;

-- 1. The replacement orders: correct batch + a line item the UI can render.
UPDATE orders
   SET line_items = '[{"qty": 1, "kind": "unit_pending", "name": "LILA (P100X, awaiting batch)", "batch": "P100X", "cost_usd": 314}]'::jsonb,
       awaiting_batch_id = 'P100X'
 WHERE order_ref IN ('R-0022', 'R-0025')
   AND kind = 'replacement'
   AND status <> 'cancelled'
   AND shipped_at IS NULL;

-- 2. The Stock-side queue rows, so the board agrees with the orders.
UPDATE replacement_queue
   SET batch_preference = 'P100X',
       notes = 'P100X replacement'
              || E'\n[correction 2026-08-19] Was recorded as P100; corrected to P100X.',
       updated_at = now()
 WHERE id IN (
   '8dbf0738-9491-433f-8b62-5c84c499180b',  -- Tamara Martin
   '63714645-bced-4962-baf8-247ce0508f47'   -- Brian Fryer
 )
   AND status = 'queued';

DO $$
DECLARE
  v_orders int;
  v_queue  int;
BEGIN
  SELECT count(*) INTO v_orders FROM orders
   WHERE order_ref IN ('R-0022', 'R-0025')
     AND awaiting_batch_id = 'P100X'
     AND line_items @> '[{"batch": "P100X", "name": "LILA (P100X, awaiting batch)"}]'::jsonb;

  SELECT count(*) INTO v_queue FROM replacement_queue
   WHERE id IN ('8dbf0738-9491-433f-8b62-5c84c499180b', '63714645-bced-4962-baf8-247ce0508f47')
     AND batch_preference = 'P100X';

  IF v_orders <> 2 OR v_queue <> 2 THEN
    RAISE EXCEPTION 'Expected 2 orders + 2 queue rows on P100X, got % + %. Rolling back.', v_orders, v_queue;
  END IF;

  RAISE NOTICE 'R-0022 (Tamara Martin) and R-0025 (Brian Fryer) moved to P100X;';
  RAISE NOTICE 'both now carry a named unit_pending line item, so the ticket shows';
  RAISE NOTICE 'the unit instead of "No items recorded on this replacement".';
END $$;

COMMIT;
