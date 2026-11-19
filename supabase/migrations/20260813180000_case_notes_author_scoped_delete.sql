-- Only a note's author may delete it.
--
-- The Refunds board now enforces this in the UI: a case's notes are readable by
-- everyone at every stage, but the add/edit/delete buttons only work for the
-- owner of the column the card is sitting in, and edit/delete additionally only
-- for the note's own author (behind a confirm step). See CaseNotes in
-- modules/PostShipment/RefundsTab.tsx.
--
-- The DB was one step behind. UPDATE was already author-scoped:
--   (is_internal_user() and author_id = auth.uid())
-- but DELETE was just is_internal_user() — any signed-in operator could remove
-- anyone's note. The notes thread is the running record of a refund case, cited
-- in manager and finance approvals, so a delete nobody can attribute is the one
-- edit that shouldn't be possible. This brings DELETE in line with UPDATE on
-- both note tables.
--
-- Safe on the existing data: all 34 rows across the two tables (13 return_notes,
-- 21 refund_notes) have a non-null author_id, so no note becomes undeletable.
-- Deliberately NOT adding an is_manager() escape hatch — that would diverge from
-- what the UI offers. A note that genuinely has to go without its author can be
-- removed in the SQL editor.

drop policy if exists return_notes_delete on public.return_notes;
create policy return_notes_delete on public.return_notes
  for delete
  using (is_internal_user() and author_id = auth.uid());

drop policy if exists refund_notes_delete on public.refund_notes;
create policy refund_notes_delete on public.refund_notes
  for delete
  using (is_internal_user() and author_id = auth.uid());
