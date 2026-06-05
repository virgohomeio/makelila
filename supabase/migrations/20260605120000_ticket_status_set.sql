-- Collapse the service-ticket status set to the seven operator-facing states:
--   closed, in_progress, waiting_on_us, waiting_on_customer,
--   queued_for_replacement, call_scheduled, on_hold
-- and migrate every existing value onto the new set.

-- 1. Trigger only stamps closed_at now (resolved removed from the set).
create or replace function public.tickets_stamp_terminal() returns trigger language plpgsql as $$
begin
  if new.status = 'closed' and (old.status is distinct from 'closed') then
    new.closed_at := coalesce(new.closed_at, now());
  end if;
  return new;
end $$;

-- 2. Drop the old constraint so the data can be remapped.
alter table public.service_tickets drop constraint if exists service_tickets_status_check;

-- 3. Migrate existing rows onto the new set.
update public.service_tickets set status = case status
  when 'new'              then 'waiting_on_us'
  when 'triaging'         then 'waiting_on_us'
  when 'needs_outreach'   then 'waiting_on_us'
  when 'scheduled'        then 'call_scheduled'
  when 'waiting_customer' then 'waiting_on_customer'
  when 'resolved'         then 'closed'
  when 'escalated'        then 'on_hold'
  else status   -- in_progress, on_hold, closed already valid
end
where status in ('new','triaging','needs_outreach','scheduled','waiting_customer','resolved','escalated');

-- 4. New default for incoming tickets.
alter table public.service_tickets alter column status set default 'waiting_on_us';

-- 5. New constraint.
alter table public.service_tickets add constraint service_tickets_status_check
  check (status in (
    'closed','in_progress','waiting_on_us','waiting_on_customer',
    'queued_for_replacement','call_scheduled','on_hold'
  ));
