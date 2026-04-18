-- QUO requires a phone to reach customers; orders without one can't be triaged
-- by the normal contact flow, so auto-flag them at insert time for attention.
-- This is a before-insert rule only: later manual status changes (e.g., a
-- reviewer approving anyway) are intentional overrides and are not bounced back.

create or replace function public.auto_flag_orders_without_phone()
returns trigger language plpgsql as $$
begin
  if new.customer_phone is null and new.status = 'pending' then
    new.status := 'flagged';
  end if;
  return new;
end;
$$;

drop trigger if exists auto_flag_orders_without_phone on public.orders;
create trigger auto_flag_orders_without_phone
  before insert on public.orders
  for each row execute function public.auto_flag_orders_without_phone();

-- Retroactively flag existing pending orders that have no phone on file.
update public.orders
   set status = 'flagged'
 where status = 'pending'
   and customer_phone is null;
