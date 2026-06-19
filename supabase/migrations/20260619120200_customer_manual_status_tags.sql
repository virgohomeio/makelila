-- Operator-applied Follow-Ups status labels, additive to the auto-derived tags.
alter table public.customers add column if not exists manual_status_tags text[] not null default '{}';
comment on column public.customers.manual_status_tags is
  'Operator-applied Follow-Ups status labels (Service → Follow-Ups), additive to the auto-derived ones.';
