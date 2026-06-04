-- Security pass Phase 1 (spec: docs/superpowers/specs/2026-06-03-security-pass-design.md).
-- Add the is_internal flag + the SECURITY DEFINER helper used by every
-- subsequent RLS policy and edge function. INERT until Phase 2 starts
-- reading it — nothing here changes behavior on its own.

-- 0. Pre-backfill: create profile rows for any auth.users that don't have
-- one. The handle_new_user trigger from 20260417015714 was supposed to do
-- this on signup, but pre-flight found at least one user (huayi) missing
-- a profile — likely signed up before the trigger existed. Without this
-- step, Phase 2's RLS rewrite would lock that user out.
insert into public.profiles (id, display_name)
select u.id, coalesce(u.raw_user_meta_data->>'full_name', split_part(u.email, '@', 1))
  from auth.users u
  left join public.profiles p on p.id = u.id
 where p.id is null
   and u.email is not null;

-- 1. Add the column.
alter table public.profiles
  add column if not exists is_internal boolean not null default false;

-- 2. Backfill: anyone currently in profiles whose corresponding auth.users
-- email ends in @virgohome.io is internal. Future signups default false;
-- non-virgohome.io contractors need a manual flip via SQL.
update public.profiles p
   set is_internal = true
  from auth.users u
 where u.id = p.id
   and lower(u.email) like '%@virgohome.io';

-- 3. Helper. SECURITY DEFINER so it reads profiles regardless of caller's
-- own RLS context. STABLE so Postgres can cache the per-statement result.
create or replace function public.is_internal_user()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
     where id = auth.uid() and is_internal = true
  );
$$;

grant execute on function public.is_internal_user() to authenticated, anon;
