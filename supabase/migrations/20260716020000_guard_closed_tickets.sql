-- makelila is the system of record for ticket status. A closed ticket must not
-- be silently reopened by a sync (HubSpot re-imports its pipeline stage and was
-- clobbering the operator's 'closed' every hour, leaving closed_at set).
--
-- Invariant: a *legitimate* operator reopen (updateTicketStatus) always clears
-- closed_at. Any update that flips a closed ticket to an open status while
-- leaving closed_at set is a clobber — keep it closed. This is defence-in-depth
-- at the DB layer, independent of any individual sync function.
CREATE OR REPLACE FUNCTION public.prevent_reopen_stale_closed()
RETURNS trigger LANGUAGE plpgsql AS $$
begin
  if old.status = 'closed'
     and new.status is distinct from 'closed'
     and new.closed_at is not null then
    new.status := 'closed';
  end if;
  return new;
end $$;

DROP TRIGGER IF EXISTS tickets_guard_reopen ON public.service_tickets;
CREATE TRIGGER tickets_guard_reopen
  BEFORE UPDATE ON public.service_tickets
  FOR EACH ROW EXECUTE FUNCTION public.prevent_reopen_stale_closed();
