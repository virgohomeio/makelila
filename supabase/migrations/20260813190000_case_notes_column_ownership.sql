-- Column ownership for case notes, enforced at the DB.
--
-- The Refunds board gives each column one owner (REFUND_COLUMN_OWNERS in
-- modules/PostShipment/RefundsTab.tsx) and, since 4e1b308, only that owner can
-- write notes on a card while it sits in their column. That was UI-only: the
-- notes policies knew nothing about which column a card is in, so a request
-- made outside the app could still write a note onto anyone's card at any
-- stage. This closes that.
--
-- Three pieces:
--   1. refund_column_owners — the owner map, as data rather than as a constant
--      baked into a function. Changing who owns a column (cover for a vacation,
--      a new hire) is then one INSERT, not a migration. Deliberately has no
--      write policy: ownership is a team decision, changed in the SQL editor,
--      not something the app can edit.
--   2. refund_column_for_{return,refund,cancellation}() — where is this case
--      RIGHT NOW? Mirrors the frontend's resolution exactly:
--        · a note anchored to a return follows its refund_approval's status
--          once compiled, and falls back to the return's own pre-refund stage
--          (intake / inspection) when there isn't one (or after an uncompile)
--        · a note on a cancellation sits in 'cancellation' until it compiles,
--          then follows the refund
--        · terminal columns (refunded / denied) resolve to a status nobody
--          owns, so a closed case's notes go read-only — same as the UI
--   3. owns_refund_column() — does the caller own that column, by email, the
--      same key the frontend gates on.
--
-- INSERT and UPDATE/DELETE both take the column check; UPDATE/DELETE keep the
-- author check they already had. One carve-out: whoever just opened a refund
-- has 15 minutes to write on it regardless of column. "Create Manual Refund"
-- is open to everyone on the board and lands the card in Completeness (Reina's
-- column) while saving the opener's own note against it — without this, Julie
-- or Pedrum opening a case would silently lose the note they filed with it.
-- The window is what keeps that from becoming a permanent back door on every
-- card its opener ever created.

-- ---------------------------------------------------------------- owner map
create table if not exists public.refund_column_owners (
  column_key  text not null,
  owner_email text not null,
  primary key (column_key, owner_email)
);

comment on table public.refund_column_owners is
  'Who owns each column of the Refunds board. Mirrors REFUND_COLUMN_OWNERS in RefundsTab.tsx — keep the two in sync.';

insert into public.refund_column_owners (column_key, owner_email) values
  ('cancellation',   'reina@virgohome.io'),
  ('intake',         'reina@virgohome.io'),
  ('inspection',     'reina@virgohome.io'),
  ('submitted',      'reina@virgohome.io'),
  ('manager_review', 'george@virgohome.io'),
  ('finance_review', 'yueli@virgohome.io'),
  ('finance_review', 'huayi@virgohome.io'),
  ('refund_queue',   'pedrum@virgohome.io')
on conflict do nothing;

alter table public.refund_column_owners enable row level security;

drop policy if exists refund_column_owners_select on public.refund_column_owners;
create policy refund_column_owners_select on public.refund_column_owners
  for select using (is_internal_user());

-- ------------------------------------------------- where is this case now?
create or replace function public.refund_column_for_refund(p_refund_id uuid)
returns text language sql stable security definer set search_path = public as $$
  select ra.status from public.refund_approvals ra where ra.id = p_refund_id;
$$;

create or replace function public.refund_column_for_return(p_return_id uuid)
returns text language sql stable security definer set search_path = public as $$
  select coalesce(
    (select ra.status from public.refund_approvals ra
      where ra.return_id = p_return_id
      order by ra.created_at desc
      limit 1),
    (select case
       when r.status in ('created', 'pickup_scheduled', 'picked_up') then 'intake'
       when r.status in ('received', 'inspected')                    then 'inspection'
       else null
     end
     from public.returns r where r.id = p_return_id)
  );
$$;

create or replace function public.refund_column_for_cancellation(p_cancellation_id uuid)
returns text language sql stable security definer set search_path = public as $$
  select coalesce(
    (select ra.status
       from public.order_cancellations c
       join public.refund_approvals ra on ra.id = c.refund_approval_id
      where c.id = p_cancellation_id),
    'cancellation'
  );
$$;

-- ------------------------------------------------------- ownership + opener
create or replace function public.owns_refund_column(p_column text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1
      from public.refund_column_owners o
      join public.profiles p on lower(p.email) = o.owner_email
     where p.id = auth.uid()
       and o.column_key = p_column
  );
$$;

-- The 15-minute grace described above: only for the card's own opener, only
-- right after they opened it.
create or replace function public.just_opened_refund(p_refund_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.refund_approvals ra
     where ra.id = p_refund_id
       and ra.submitted_by = auth.uid()
       and ra.created_at > now() - interval '15 minutes'
  );
$$;

-- The column a refund_notes row belongs to — it carries either a refund_id or
-- a cancellation_id (refund_notes_owner_check), never neither.
create or replace function public.may_write_refund_note(p_refund_id uuid, p_cancellation_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select case
    when p_refund_id is not null then
      public.owns_refund_column(public.refund_column_for_refund(p_refund_id))
        or public.just_opened_refund(p_refund_id)
    when p_cancellation_id is not null then
      public.owns_refund_column(public.refund_column_for_cancellation(p_cancellation_id))
    else false
  end;
$$;

-- ------------------------------------------------------------------ policies
drop policy if exists return_notes_insert on public.return_notes;
create policy return_notes_insert on public.return_notes
  for insert
  with check (is_internal_user() and owns_refund_column(refund_column_for_return(return_id)));

drop policy if exists return_notes_update on public.return_notes;
create policy return_notes_update on public.return_notes
  for update
  using      (is_internal_user() and author_id = auth.uid()
              and owns_refund_column(refund_column_for_return(return_id)))
  with check (is_internal_user() and author_id = auth.uid()
              and owns_refund_column(refund_column_for_return(return_id)));

drop policy if exists return_notes_delete on public.return_notes;
create policy return_notes_delete on public.return_notes
  for delete
  using (is_internal_user() and author_id = auth.uid()
         and owns_refund_column(refund_column_for_return(return_id)));

drop policy if exists refund_notes_insert on public.refund_notes;
create policy refund_notes_insert on public.refund_notes
  for insert
  with check (is_internal_user() and may_write_refund_note(refund_id, cancellation_id));

drop policy if exists refund_notes_update on public.refund_notes;
create policy refund_notes_update on public.refund_notes
  for update
  using      (is_internal_user() and author_id = auth.uid()
              and may_write_refund_note(refund_id, cancellation_id))
  with check (is_internal_user() and author_id = auth.uid()
              and may_write_refund_note(refund_id, cancellation_id));

drop policy if exists refund_notes_delete on public.refund_notes;
create policy refund_notes_delete on public.refund_notes
  for delete
  using (is_internal_user() and author_id = auth.uid()
         and may_write_refund_note(refund_id, cancellation_id));

-- SELECT is untouched on both tables: every internal user reads every note at
-- every stage. The thread is how the next person picks the case up.
