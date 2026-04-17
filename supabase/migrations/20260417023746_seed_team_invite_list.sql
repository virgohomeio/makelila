-- team_invite_list: maps emails to canonical display names.
-- On first sign-in, handle_new_user trigger will prefer this over Google's full_name.
create table if not exists public.team_invite_list (
  email text primary key,
  display_name text not null
);

insert into public.team_invite_list (email, display_name) values
  ('pedrum@virgohome.io',  'Pedrum'),
  ('raymond@virgohome.io', 'Raymond'),
  ('aaron@virgohome.io',   'Aaron'),
  ('ashwini@virgohome.io', 'Ashwini'),
  ('junaid@virgohome.io',  'Junaid'),
  ('huayi@virgohome.io',   'Huayi'),
  ('george@virgohome.io',  'George')
on conflict (email) do update set display_name = excluded.display_name;

-- Update handle_new_user to prefer invite_list display_name
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer as $$
declare
  override_name text;
begin
  select display_name into override_name
    from public.team_invite_list where email = new.email;

  insert into public.profiles (id, display_name)
  values (
    new.id,
    coalesce(override_name, new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1))
  );
  return new;
end;
$$;

-- RLS: read-only for authenticated
alter table public.team_invite_list enable row level security;
create policy "invite_list_select" on public.team_invite_list
  for select to authenticated using (true);
