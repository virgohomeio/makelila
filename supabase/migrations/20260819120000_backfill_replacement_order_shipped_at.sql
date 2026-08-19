-- Stamp orders.shipped_at on replacement orders that demonstrably shipped.
--
-- BACKGROUND
-- orders.shipped_at is written in exactly one place: shipQueuedReplacementsForTicket(),
-- which fires only when a service ticket is set to the 'replacement_sent' status.
-- No ticket has ever used that status (0 of 441 by status, 0 by tag) — operators
-- close the case directly instead. Result: 1 of 47 replacement orders has a
-- shipped_at, and the rest sit in Sales › Orders › Replacement forever because
-- that list filters on `shipped_at IS NULL`.
--
-- SCOPE: 3 rows. Only orders where a unit in Stock explicitly names the order
-- in units.customer_order_ref AND that unit is shipped — an operator-made link
-- with a real ship date, so the timestamp written here is recorded fact.
--
-- DELIBERATELY NOT BACKFILLED: the other 12 orders whose linked ticket is
-- closed (R-0002, R-0007, R-0008, R-0010, R-0013, R-0035, R-0036, R-0042,
-- R-0043, R-0048, R-0050, R-0061). Nothing anywhere records when — or whether —
-- those shipped; most are parts, which never get a unit row. The only available
-- timestamp is the ticket's closed_at, which is when the case was resolved, not
-- when a box left the building. Writing that into shipped_at would invent a
-- shipment date and quietly corrupt any future lead-time or fulfilment metric.
-- They are already out of the operator's way: bucketOrders() now treats a
-- closed ticket as a fulfilment signal, so they no longer appear in the tab.
--
-- Idempotent: guarded on shipped_at IS NULL.

BEGIN;

UPDATE orders o
   SET shipped_at = u.shipped_at,
       status     = 'approved'
  FROM units u
 WHERE u.customer_order_ref = o.order_ref
   AND u.status     = 'shipped'
   AND u.shipped_at IS NOT NULL
   AND o.kind       = 'replacement'
   AND o.shipped_at IS NULL
   AND o.status    <> 'cancelled'
   AND o.order_ref IN ('R-0005', 'R-0027', 'R-0031');

DO $$
DECLARE
  v_done int;
BEGIN
  SELECT count(*) INTO v_done
    FROM orders
   WHERE order_ref IN ('R-0005', 'R-0027', 'R-0031') AND shipped_at IS NOT NULL;

  IF v_done <> 3 THEN
    RAISE EXCEPTION 'Expected 3 replacement orders stamped, got %. Rolling back.', v_done;
  END IF;

  RAISE NOTICE 'Backfilled shipped_at on 3 replacement orders from their Stock unit.';
  RAISE NOTICE '12 closed-ticket orders left with shipped_at NULL on purpose — no';
  RAISE NOTICE 'shipment date exists for them and closed_at is not one.';
END $$;

COMMIT;
