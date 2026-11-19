-- One email a day to EZ Trans, not one per box.
--
-- The 3PL asked for every shipment scheduled for a given day to arrive in a
-- single message: a picker working a stack of ten cartons out of ten separate
-- emails loses one. So step 3 of the fulfillment queue now *confirms* an order
-- for Goorooship — carrier, tracking number, label and packing list pinned to
-- the queue row — and the confirmed rows accumulate until an operator presses
-- "Email Today's Fulfilled Orders to Goorooship" at the bottom of the queue.
--
-- Four columns carry that, all on fulfillment_queue next to the carrier and
-- tracking number they sit beside in the UI:
--
--   eztrans_confirmed_at   when the order joined a day's batch. The batch a
--                          row belongs to IS this timestamp's local date —
--                          there is no batch table, because a batch has no
--                          identity beyond "what was confirmed that day" and
--                          a row can be pulled back out of one by clearing it.
--   eztrans_confirmed_by   who confirmed it (auth.users.id, same convention as
--                          label_confirmed_by).
--   eztrans_packing_list   the operator's edit of the packing list for THIS
--                          order, or null to use the eztrans_packing_list
--                          template. Null is meaningful: it means "whatever
--                          the saved template says at send time", which is the
--                          same precedence the per-order send already had.
--                          It used to live in the browser's localStorage,
--                          which an end-of-day send from another machine could
--                          not read.
--   eztrans_batch_sent_at  when the email carrying this order actually went.
--                          Non-null excludes the row from every later batch,
--                          which is what stops a second press of the button
--                          from double-booking the 3PL.
--
-- Nothing here is destructive and nothing is backfilled: rows already mailed
-- by the per-order path have all four null and simply never appear in a batch.

alter table public.fulfillment_queue
  add column if not exists eztrans_confirmed_at  timestamptz,
  add column if not exists eztrans_confirmed_by  uuid,
  add column if not exists eztrans_packing_list  text,
  add column if not exists eztrans_batch_sent_at timestamptz;

comment on column public.fulfillment_queue.eztrans_confirmed_at is
  'When this order was confirmed into a Goorooship day batch. Its local date IS the batch.';
comment on column public.fulfillment_queue.eztrans_packing_list is
  'Per-order packing-list override. Null means use the eztrans_packing_list template.';
comment on column public.fulfillment_queue.eztrans_batch_sent_at is
  'When the daily batch email carrying this order went out. Non-null excludes it from later batches.';

-- The only query that reads these: "what is waiting to be sent". Partial, so
-- the index stays the size of one day's work rather than the whole queue.
create index if not exists fulfillment_queue_eztrans_pending_idx
  on public.fulfillment_queue (eztrans_confirmed_at desc)
  where eztrans_confirmed_at is not null and eztrans_batch_sent_at is null;

-- The batch wording, as an operator-editable template.
--
-- Resolved the same way as every other template in this app:
--   1. this row
--   2. the built-in default in _shared/eztransBatch.ts
-- so an environment that has not applied this migration still sends — it just
-- sends the stock wording. The body below is byte-identical to that default,
-- and eztransBatch.test.ts fails the build if the two drift.
--
-- {{orders_block}} is generated, not typed: the send builds the numbered list
-- of shipments from the confirmed queue rows, so an edit here changes the
-- words around the list and never which orders are in it.
insert into public.email_templates (key, name, category, description, subject, body, variables, channel, active)
values
(
  'eztrans_daily_batch',
  'EZ Trans daily batch (Goorooship)',
  'fulfillment',
  'The one end-of-day email to the EZ Trans 3PL carrying every order confirmed for Goorooship that day. {{orders_block}} is generated from the confirmed queue rows — each order''s label and packing list ride along as one PDF named for the customer and the tracking number, with the UPS pesticide worksheet as a separate file.',
  E'Orders to fulfill — {{date}} · {{order_count}} shipment(s)',
  E'Hello EZ Trans team,\n\nThese are the orders booked on Goorooship for {{date}}. All of them are ready to be picked and handed to the carrier. {{attachments_note}}\n\n{{orders_block}}\n\nPlease reply to confirm once the units are picked and the shipments are on their way.\n\nThank you,\nThe VCycene Team',
  array['date','order_count','orders_block','attachments_note']::text[],
  'email',
  true
)
on conflict (key) do nothing;
