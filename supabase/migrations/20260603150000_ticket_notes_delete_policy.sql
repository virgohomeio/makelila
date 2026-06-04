-- Allow authenticated ops users to delete ticket notes.
create policy "ticket_notes_delete" on public.ticket_notes
  for delete to authenticated using (true);
