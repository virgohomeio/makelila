-- Notes on a cancellation request card.
--
-- refund_notes.refund_id was NOT NULL, so a note could only exist once a refund
-- row did. But the cancellation card sits a column BEFORE the refund exists —
-- it's where the operator works out whether there's money to give back at all,
-- which is exactly when the context is worth writing down.
--
-- The table now takes either owner:
--   refund_id       → a note on the refund itself (direct refunds)
--   cancellation_id → a note on the cancellation request
--
-- Cancellation is the better anchor of the two for a cancellation-born case:
-- compiling keeps the order_cancellations row (status flips to 'completed' and
-- it stores refund_approval_id), while uncompiling DELETES the refund row and
-- would cascade its notes away. Anchoring to the cancellation means the thread
-- survives the card moving in either direction — the same invariant return-
-- anchored notes already have. See caseNoteAnchor().

alter table public.refund_notes
  alter column refund_id drop not null;

alter table public.refund_notes
  add column if not exists cancellation_id uuid
    references public.order_cancellations(id) on delete cascade;

alter table public.refund_notes
  drop constraint if exists refund_notes_owner_check;

alter table public.refund_notes
  add constraint refund_notes_owner_check
  check (refund_id is not null or cancellation_id is not null);

create index if not exists refund_notes_cancellation_id_idx
  on public.refund_notes(cancellation_id);

-- RLS unchanged: refund_notes policies are is_internal_user() for select/insert/
-- delete and (is_internal_user() and author_id = auth.uid()) for update. None of
-- them reference refund_id, so cancellation-owned notes are covered as-is.
