-- Add support@virgohome.io (Raquel) to the team invite list so her first
-- sign-in gets the display_name "Raquel" and is_internal=true, matching the
-- pattern used for Julie/Lezhong/Reina.

insert into public.team_invite_list (email, display_name) values
  ('support@virgohome.io', 'Raquel')
on conflict (email) do update set display_name = excluded.display_name;
