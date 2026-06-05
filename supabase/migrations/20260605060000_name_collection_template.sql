-- Backlog #58 Journey-tab follow-up — name-collection workflow.
--
-- The Journey tab can't render a card for a customer without a name. The
-- workflow: send those customers (who DO have an email) a templated
-- email asking them to reply with their name, then track the send so
-- we don't re-spam them.
--
-- Two pieces:
--   1. customers.name_request_sent_at — dedupe stamp (NULL = never sent;
--      operator's UI re-enables sending after 30+ days if no reply).
--   2. email_templates row 'name_collection_request' — operator-editable
--      copy living in the Templates module.

alter table public.customers
  add column if not exists name_request_sent_at timestamptz;

comment on column public.customers.name_request_sent_at is
  'When the Journey tab last sent the name-collection email. NULL = never.';

-- Idempotent template seed.
insert into public.email_templates (key, name, category, description, subject, body, variables, channel, active)
values (
  'name_collection_request',
  'Name collection request',
  'support',
  'Asks a customer for their name when we have their email but no name on file (surfaced from the Journey tab).',
  'Quick favor — what name should we use for you?',
  E'Hi there,\n\nWe have your email on file at VCycene / LILA Composter, but we don''t have a name to address you by.\n\nCould you reply with the name you''d like us to use? It helps us personalize updates about your order and any follow-ups.\n\nThanks!\n— The VCycene team',
  array[]::text[],
  'email',
  true
)
on conflict (key) do nothing;
