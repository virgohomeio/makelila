-- Record who holds team unit LL01-00000000208: Huayi.
--
-- Fifteen units are the team's rather than a customer's (is_team_test, or
-- status 'team-test'), and only three said who had them — as free text in
-- units.customer_name: 'Pedrum', 'Junaid Siddiqui - Office Machine',
-- 'Hassan - Marketing Intern'. The other twelve were blank, which is why
-- raising a support ticket for a colleague could not find their machine.
--
-- This is a one-row data write in the shape the column already uses, not a
-- schema change. The app writes the same field from the New Ticket dialog
-- (setTeamUnitHolder in app/src/lib/team.ts) when an operator picks a team
-- unit that has no holder on file, so the remaining eleven get recorded as
-- they come up rather than being guessed at here.
--
-- Guarded on customer_name being unset so re-running it can never overwrite a
-- correction an operator has since made.
-- Spec: docs/superpowers/specs/2026-09-24-team-member-support-tickets-design.md

update public.units
   set customer_name = 'Huayi'
 where serial = 'LL01-00000000208'
   and coalesce(btrim(customer_name), '') = '';
