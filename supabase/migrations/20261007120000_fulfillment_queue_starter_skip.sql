-- Ordering the compost starter becomes part of scheduling a pickup.
--
-- Step 3 of the fulfillment queue is where a shipment gets booked: a carrier
-- and a tracking number go on the row, an EZ Trans shipment gets its Goorooship
-- email, and "Pickup scheduled" hands the carton over. Ordering the customer's
-- starter soil off Amazon sat outside all of that. The field for its tracking
-- number was US-only and optional, and on 2026-10-07 three of 63 US rows had
-- one — so the soil was ordered when somebody remembered, and the queue could
-- not tell an order whose starter was on its way from one whose was never
-- placed.
--
-- The number itself already has a home: fulfillment_queue.starter_tracking_num.
-- What was missing is the other answer — this order ships no starter soil, and
-- here is why. Without somewhere to record that, making the number mandatory
-- strands every order that legitimately has none, which is exactly how the
-- US-only gate failed in September (5a01566: "an order without one had no
-- number to paste and no way past the step"). A replacement is exempt by its
-- kind, in code; anything else needs an operator to say so in words.
--
-- Nullable, additive, no backfill. Every existing row reads as "not skipped",
-- which is true of all of them.

alter table fulfillment_queue
  add column if not exists starter_skipped_at  timestamptz,
  add column if not exists starter_skipped_by  uuid references auth.users(id),
  add column if not exists starter_skip_reason text;

comment on column fulfillment_queue.starter_skipped_at is
  'When an operator declared that this order ships no compost starter. Null means the Amazon starter tracking number is still required before step 3 can be confirmed.';
comment on column fulfillment_queue.starter_skipped_by is
  'Who declared it. The reason is also written to activity_log as fq_starter_skipped.';
comment on column fulfillment_queue.starter_skip_reason is
  'Why no starter soil goes with this order. Required whenever starter_skipped_at is set.';

-- A skip with no reason is the thing this is here to prevent: on the row it
-- would read exactly like a starter somebody forgot, and months later nobody
-- could tell the two apart.
alter table fulfillment_queue
  drop constraint if exists fulfillment_queue_starter_skip_reason;
alter table fulfillment_queue
  add constraint fulfillment_queue_starter_skip_reason
  check (starter_skipped_at is null or btrim(coalesce(starter_skip_reason, '')) <> '');
