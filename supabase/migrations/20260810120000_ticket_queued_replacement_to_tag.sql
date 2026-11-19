-- "Queued for Replacement" moves from service_tickets.status to tags[].
--
-- A ticket queued for a replacement needs to carry other labels at the same
-- time (on hold, call scheduled, ...). `status` is single-valued and drives SLA
-- aging / closed_at / the state machine, so the replacement marker moves to the
-- existing multi-select `tags` column (added in 20260714000000).
--
-- The two functions below are the ONLY way the app mutates a single tag. A
-- read-modify-write from TypeScript would be a TOCTOU race: an operator toggling
-- a tag in the panel while a replacement order is being created could lose one
-- of the two writes. Both are idempotent, so retries are safe.
--
-- security invoker (unlike decrement_part_on_hand, which is definer because it
-- writes the shared parts table) — ticket RLS must still apply to the caller.

create or replace function public.add_ticket_tag(p_ticket_id uuid, p_tag text)
returns void
language sql
security invoker
set search_path = public, pg_temp
as $$
  update public.service_tickets
     set tags = array_append(tags, p_tag)
   where id = p_ticket_id
     and not (p_tag = any(tags));
$$;

create or replace function public.remove_ticket_tag(p_ticket_id uuid, p_tag text)
returns void
language sql
security invoker
set search_path = public, pg_temp
as $$
  update public.service_tickets
     set tags = array_remove(tags, p_tag)
   where id = p_ticket_id;
$$;

revoke all on function public.add_ticket_tag(uuid, text) from anon, public;
revoke all on function public.remove_ticket_tag(uuid, text) from anon, public;
grant execute on function public.add_ticket_tag(uuid, text) to authenticated;
grant execute on function public.remove_ticket_tag(uuid, text) to authenticated;

-- Backfill: 31 rows as of 2026-08-10. These tickets are waiting on a
-- replacement to arrive, so 'waiting_on_customer' is the honest status — it
-- stops the SLA clock running against ops and keeps them out of Action Needed
-- (which would otherwise go 194 -> 225). Visually nothing changes in the
-- Support list: StatusPills renders the same "Queued for P100X Replacement"
-- text for the tag variant as it did for the status pill.
update public.service_tickets
   set tags   = array_append(tags, 'queued_for_replacement'),
       status = 'waiting_on_customer'
 where status = 'queued_for_replacement'
   and not ('queued_for_replacement' = any(tags));
