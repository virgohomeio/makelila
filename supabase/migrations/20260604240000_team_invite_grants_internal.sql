-- Adding to team_invite_list now ALSO grants is_internal=true on first
-- sign-in. Previously the trigger only used the table for display_name
-- override, and every new @virgohome.io operator had to be manually
-- flipped to is_internal=true after their first sign-in. With this update,
-- "in team_invite_list" is the explicit allow-list for internal access.

insert into public.team_invite_list (email, display_name)
values ('lezhong@virgohome.io', 'Lezhong')
on conflict (email) do update set display_name = excluded.display_name;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
as $$
declare
  invite_row public.team_invite_list%rowtype;
begin
  select * into invite_row from public.team_invite_list where email = new.email;

  insert into public.profiles (id, display_name, is_internal)
  values (
    new.id,
    coalesce(invite_row.display_name, new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)),
    invite_row.email is not null
  );
  return new;
end;
$$;
