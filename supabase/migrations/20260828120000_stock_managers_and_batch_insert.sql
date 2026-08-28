-- Stock batch administration.
--
-- `batches` has carried SELECT + UPDATE policies since 20260604200000 and no
-- INSERT policy at all, so no browser client could ever create a batch —
-- every batch to date arrived as a hand-written migration. This adds the
-- missing INSERT policy, gated on a new per-person allowlist.
--
-- Deliberately NOT a new role. user_role stays ('operator','manager',
-- 'finance','admin'). Junaid — who runs Stock — is an `operator`, and
-- `operator` is the default every new sign-in receives, so gating on it
-- would gate on everyone. Moving him to a new role would silently revoke
-- submit_to_manager / move_refund_flow / edit_warranty_registration, which
-- all list 'operator' in ACTION_ROLES (app/src/lib/permissions.ts).
--
-- Shape mirrors Hiring's posting_interviewers + can_view_posting()
-- (20260724140000_hiring_schema.sql:57-93).

create table if not exists public.stock_managers (
  profile_id uuid primary key references public.profiles(id) on delete cascade,
  added_by   uuid references auth.users(id),
  created_at timestamptz not null default now()
);

alter table public.stock_managers enable row level security;

-- is_finance() already resolves to finance-or-admin, so leadership is always
-- included without being listed.
create or replace function public.can_manage_batches()
returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_finance() or exists (
    select 1 from public.stock_managers where profile_id = auth.uid()
  );
$$;

grant execute on function public.can_manage_batches() to authenticated;

-- SELECT is deliberately narrow: a user can resolve their OWN membership
-- without enumerating the list. Gating SELECT on can_manage_batches() would
-- be circular — a non-member could not read the table to learn they are not
-- a member.
drop policy if exists "stock_managers_select" on public.stock_managers;
create policy "stock_managers_select" on public.stock_managers
  for select to authenticated
  using (profile_id = auth.uid() or public.is_finance());

drop policy if exists "stock_managers_insert" on public.stock_managers;
create policy "stock_managers_insert" on public.stock_managers
  for insert to authenticated
  with check (public.is_finance());

drop policy if exists "stock_managers_delete" on public.stock_managers;
create policy "stock_managers_delete" on public.stock_managers
  for delete to authenticated
  using (public.is_finance());

-- Seed Junaid. Guarded: if the profile does not exist yet (he has not signed
-- in on this environment), this inserts nothing rather than failing.
insert into public.stock_managers (profile_id)
select p.id
  from public.profiles p
  join auth.users u on u.id = p.id
 where lower(u.email) = 'junaid@virgohome.io'
on conflict (profile_id) do nothing;

-- The actual security boundary for the new UI.
drop policy if exists "batches_insert" on public.batches;
create policy "batches_insert" on public.batches
  for insert to authenticated
  with check (public.can_manage_batches());
