-- Marketing → Email tab "Subject" column. The subject line a recipient sees,
-- pulled by sync-klaviyo-campaigns from the campaign's email message
-- (definition.content.subject via include=campaign-messages). NULL = a row
-- synced before this column existed, or a message that carries no subject; the
-- UI reads NULL as a dash. Idempotent, so it is a no-op where it has already
-- been applied to a remote environment.
alter table public.klaviyo_campaigns add column if not exists subject_line text;

comment on column public.klaviyo_campaigns.subject_line is
  'Email subject line shown to recipients, from the Klaviyo campaign message (definition.content.subject). Set by sync-klaviyo-campaigns. NULL = pre-column row or no subject on the message.';
