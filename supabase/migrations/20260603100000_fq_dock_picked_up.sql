-- Walkthrough #28: add "Carrier picked up" to the dock handoff checklist
-- so ops has explicit confirmation that the carrier actually took the box
-- away (vs. just being notified for pickup). Closes a gap where boxes sat
-- on the dock for days because nobody tracked the pickup event.
alter table public.fulfillment_queue
  add column if not exists dock_picked_up boolean not null default false;
