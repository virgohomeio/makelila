-- 1. New operator-facing ticket status: 'return_refund' ("Return/Refund").
--
-- Extends the set collapsed in 20260605120000. Sits alongside
-- queued_for_replacement as the other post-sale escalation state.
alter table public.service_tickets drop constraint if exists service_tickets_status_check;
alter table public.service_tickets add constraint service_tickets_status_check
  check (status in (
    'closed','in_progress','waiting_on_us','waiting_on_customer',
    'queued_for_replacement','return_refund','call_scheduled','on_hold'
  ));

-- 2. Enforce the multi-select invariant: `tags` holds the EXTRA statuses only,
--    never the primary that `status` already carries.
--
-- Statuses became multi-select in 20260810120000: `status` is the primary and
-- `tags` the rest. Several writers set `status` on its own — the Gmail sync
-- (sync-gmail-tickets), the reclassifier (reclassify-ticket), and the
-- replacement workflow. If `tags` also held the primary, those writes would
-- strand the OLD primary in `tags`, and the ticket would silently accumulate a
-- stale status that the UI then renders as an extra pill.
--
-- A trigger, not just app-side discipline, because those writers are edge
-- functions using the service role and will never route through
-- setTicketStatuses().
create or replace function public.tickets_normalize_status_tags() returns trigger
language plpgsql as $$
begin
  new.tags := array_remove(coalesce(new.tags, '{}'), new.status);
  return new;
end $$;

drop trigger if exists trg_tickets_normalize_status_tags on public.service_tickets;
create trigger trg_tickets_normalize_status_tags
  before insert or update on public.service_tickets
  for each row execute function public.tickets_normalize_status_tags();

-- 3. Backfill rows already carrying the primary in both columns.
update public.service_tickets
   set tags = array_remove(tags, status)
 where status = any(tags);
