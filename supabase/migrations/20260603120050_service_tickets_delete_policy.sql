-- Allow authenticated ops users to delete service tickets.
-- Child rows (ticket_messages, ticket_attachments, ticket_classification_log)
-- already cascade via `on delete cascade`, so no child policies are needed.
create policy "tickets_delete" on public.service_tickets
  for delete to authenticated using (true);
