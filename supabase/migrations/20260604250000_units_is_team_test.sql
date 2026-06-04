-- Distinguish team-test units from real customer units (backlog #59).
-- Today, units the team uses for internal testing get mixed into the
-- Dashboard / Customers list / profitability rollups, distorting any
-- per-customer signal (e.g. #58 would show Huayi as our "worst customer"
-- since he has multiple test machines and zero revenue).
--
-- Add an explicit boolean. Backfill all current `status='team-test'`
-- units, plus any unit whose `customer_name` exactly matches a person in
-- `team_invite_list.display_name` (catches the "Pedrum" case where his
-- test unit is in status='shipped' but assigned to himself).

alter table public.units
  add column if not exists is_team_test boolean not null default false;

update public.units u
   set is_team_test = true
 where status = 'team-test'
    or exists (
      select 1 from public.team_invite_list t
       where lower(u.customer_name) = lower(t.display_name)
    );

create index if not exists units_is_team_test_idx
  on public.units (is_team_test) where is_team_test = true;
