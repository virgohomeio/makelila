-- Security pass Phase 4 (spec: docs/superpowers/specs/2026-06-03-security-pass-design.md).
-- Replace the loose UUID-regex anon storage policy with a real
-- service_tickets-row existence check. The customer-form code already
-- inserts the ticket first then uploads to {ticket_id}/...; this just
-- adds a real check instead of a regex-shape check. A leaked ticket-id
-- is still uploadable to but the attacker would need an active
-- customer-form ticket UUID, which we don't expose publicly.

create or replace function public.customer_form_ticket_exists(p_ticket_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.service_tickets
     where id = p_ticket_id and source = 'customer_form'
  );
$$;
grant execute on function public.customer_form_ticket_exists(uuid) to anon;

drop policy if exists "ticket_attachments_write_anon" on storage.objects;
create policy "ticket_attachments_write_anon" on storage.objects
  for insert to anon
  with check (
    bucket_id = 'ticket-attachments'
    and public.customer_form_ticket_exists(
      ((storage.foldername(name))[1])::uuid
    )
  );
