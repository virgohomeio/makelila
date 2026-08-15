-- Ticket status 'replacement_sent' — the marker an operator sets on a service
-- ticket once the replacement they queued has actually gone out the door.
--
-- Applying it in the app hands the linked replacement order(s) over to
-- Fulfillment › Queue › SHIPPED (a fulfillment_queue row at step 6); see
-- shipQueuedReplacementsForTicket() in app/src/lib/orders.ts.
--
-- Purely additive: relaxes the CHECK so the new value is writable. The `tags`
-- array (the multi-select half of the status model) has no CHECK, so only the
-- primary `status` column needs the widening.

alter table public.service_tickets
  drop constraint if exists service_tickets_status_check;

alter table public.service_tickets
  add constraint service_tickets_status_check check (status in (
    'waiting_on_us',
    'in_progress',
    'waiting_on_customer',
    'queued_for_replacement',
    'replacement_sent',
    'return_refund',
    'call_scheduled',
    'on_hold',
    'closed'
  ));
