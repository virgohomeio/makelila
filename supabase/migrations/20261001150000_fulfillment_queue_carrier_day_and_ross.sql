-- Add Day & Ross to the carriers fulfillment_queue.carrier accepts.
--
-- The column is CHECK-constrained, not free text (orders.carrier is the free
-- text one). A carrier offered in the Queue / EZ Trans dropdown but missing
-- from this list does not degrade the write, it fails it — that is the R-0069
-- half-shipment, where the order went out, the queue row stayed at step 1 and
-- the picker was invited to send a second box. So the dropdown
-- (lib/queueCarrier.ts QUEUE_CARRIERS) and this constraint are widened
-- together, and the list below is the whole list, not a delta.

alter table public.fulfillment_queue
  drop constraint if exists fulfillment_queue_carrier_check;

alter table public.fulfillment_queue
  add constraint fulfillment_queue_carrier_check
  check (carrier is null or carrier = any (array[
    'UPS','FedEx','Purolator','Canada Post','Canpar','GLS','Day & Ross'
  ]));
