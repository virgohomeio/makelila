-- Roster update: Aaron and Ashwini are off the team; add Reina.
-- team_invite_list only maps emails -> canonical display names (used by
-- handle_new_user on first sign-in); it does not itself gate auth (that's the
-- @virgohome.io domain check in auth.tsx). Reina is already in the ticket
-- OPS_OWNERS dropdown; this brings the roster list in line.

delete from public.team_invite_list
  where email in ('aaron@virgohome.io', 'ashwini@virgohome.io');

insert into public.team_invite_list (email, display_name) values
  ('reina@virgohome.io', 'Reina')
on conflict (email) do update set display_name = excluded.display_name;
