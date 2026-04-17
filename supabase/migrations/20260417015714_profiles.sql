-- profiles: 1:1 with auth.users, stores display name and role
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  role text default 'member',
  created_at timestamptz not null default now()
);

-- Auto-insert profile on new auth user signup
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1))
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- RLS: all authenticated users can read all profiles; only the owner can update
alter table public.profiles enable row level security;

create policy "profiles_select_all_authenticated"
  on public.profiles for select
  to authenticated
  using (true);

create policy "profiles_update_self"
  on public.profiles for update
  to authenticated
  using (auth.uid() = id);
