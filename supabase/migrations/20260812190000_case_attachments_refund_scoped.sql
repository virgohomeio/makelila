-- Case photos without a return.
--
-- return_attachments.return_id was NOT NULL, so photos could only ever hang off
-- a returns row. That left every refund card with no return behind it — one
-- compiled from a cancellation form, or opened by hand — able to take notes but
-- not a single photo, even though the operator working the case has the same
-- evidence to file (screenshots of the thread, payment proof, packaging shots).
--
-- The table now takes either owner:
--   return_id  → a return-born case; photos keep showing on the Returns board
--   refund_id  → a refund with no return; photos live on the refund card
-- Exactly one is required; nothing else about the table changes, so existing
-- rows and the context/inspection split carry over untouched.

alter table public.return_attachments
  alter column return_id drop not null;

alter table public.return_attachments
  add column if not exists refund_id uuid
    references public.refund_approvals(id) on delete cascade;

alter table public.return_attachments
  drop constraint if exists return_attachments_owner_check;

alter table public.return_attachments
  add constraint return_attachments_owner_check
  check (return_id is not null or refund_id is not null);

create index if not exists return_attachments_refund_id_category_idx
  on public.return_attachments(refund_id, category);

-- RLS is unchanged: the existing select/insert/delete policies are
-- is_internal_user() on the whole table and never referenced return_id, so they
-- cover refund-owned rows as-is. Same for the 'return-documents' storage
-- policies, which are bucket-scoped, not path-scoped.
