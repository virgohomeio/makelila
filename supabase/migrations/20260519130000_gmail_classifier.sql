-- Adds the classifier output `topic` column to service_tickets.
--
-- `category` (existing, 3-value: onboarding/support/repair) tags the intake
-- channel. `topic` (this column, 15-value) tags the inferred conversation
-- subject from the classifier in PR2 of the Gmail ticket pipeline.
--
-- Topic stays null for non-gmail tickets (and for gmail tickets the classifier
-- hasn't reached yet). Classifier output is written by:
--   - sync-gmail-tickets (inline after thread upsert)
--   - reclassify-ticket (on-demand from UI)
-- Both functions only write topic/summary/suggested_next_action/priority when
-- is_manually_overridden = false (the flag added in PR1).

alter table public.service_tickets
  add column if not exists topic text;

alter table public.service_tickets drop constraint if exists service_tickets_topic_check;
alter table public.service_tickets add constraint service_tickets_topic_check
  check (topic is null or topic in (
    'return_hardware_defect',
    'warranty_replacement',
    'refund',
    'software_firmware',
    'complaint',
    'callback',
    'assembly_support',
    'troubleshooting',
    'logistics_pickup',
    'order_fulfillment',
    'in_person_service',
    'appointment',
    'marketing_social',
    'closed_acknowledgment',
    'other'
  ));

create index if not exists idx_tickets_topic
  on public.service_tickets (topic, status, priority)
  where topic is not null;
