-- Auto-populate service_tickets.unit_serial from the customer's unit
-- (backlog #36 / #85). The unit is resolved via units.customer_id =
-- ticket.customer_id, taking the most-recently-shipped unit when a customer
-- has more than one. Fires on every intake path (Gmail/Quo sync, customer
-- form, manual, classifier) and only fills when a serial isn't already set —
-- never clobbers an operator-entered serial.

create or replace function public.set_ticket_unit_serial()
returns trigger
language plpgsql
as $$
begin
  if new.unit_serial is null and new.customer_id is not null then
    select u.serial into new.unit_serial
      from public.units u
     where u.customer_id = new.customer_id
     order by u.shipped_at desc nulls last
     limit 1;
  end if;
  return new;
end;
$$;

drop trigger if exists tickets_set_unit_serial on public.service_tickets;
create trigger tickets_set_unit_serial
  before insert or update of customer_id on public.service_tickets
  for each row execute function public.set_ticket_unit_serial();

-- One-time backfill: fill existing tickets that have a customer but no serial.
update public.service_tickets t
   set unit_serial = sub.serial
  from (
    select distinct on (u.customer_id) u.customer_id, u.serial
      from public.units u
     where u.customer_id is not null
     order by u.customer_id, u.shipped_at desc nulls last
  ) sub
 where t.unit_serial is null
   and t.customer_id is not null
   and t.customer_id = sub.customer_id;
