-- Add Ryan Yuan (ryanyuan32@gmail.com) as an externally-allowed user.
-- First non-@virgohome.io account permitted in makelila. The existing model
-- assumes everyone is a Google Workspace member of virgohome.io — gates:
--   1. auth.tsx requireInternalDomain() — rejects non-@virgohome.io emails
--      client-side (signs them out immediately after sign-in).
--   2. supabase.auth.signInWithOAuth({ hd: 'virgohome.io' }) pin — restricts
--      the Google account chooser to Workspace accounts only.
--   3. profiles.is_internal flag — set true only for @virgohome.io emails on
--      signup. is_internal_user() is the SECURITY DEFINER STABLE helper that
--      every subsequent RLS policy + edge function uses to gate access.
--
-- This migration introduces an allowlist table for exceptions and patches
-- handle_new_user so allowlisted emails get is_internal=true on first
-- sign-in. Companion code edit in app/src/lib/auth.tsx adds the same
-- email to the client-side allowlist + drops the hd OAuth pin so non-
-- Workspace Google accounts can reach the OAuth flow at all.

-- ============================================================
-- 1. Allowlist table — single source of truth for is_internal flips on
--    non-@virgohome.io emails. Future externals get inserted here.
-- ============================================================
create table if not exists public.external_email_allowlist (
  email text primary key,
  display_name text not null,
  notes text,
  added_by text,
  added_at timestamptz not null default now()
);

alter table public.external_email_allowlist enable row level security;

-- Authenticated read so the client could surface "external users" later if
-- needed. Writes are service-role only (no policy = denied).
drop policy if exists "external_email_allowlist_select_all_auth"
  on public.external_email_allowlist;
create policy "external_email_allowlist_select_all_auth"
  on public.external_email_allowlist for select
  to authenticated
  using (true);

-- ============================================================
-- 2. Seed Ryan Yuan.
-- ============================================================
insert into public.external_email_allowlist (email, display_name, notes, added_by) values
  ('ryanyuan32@gmail.com', 'Ryan Yuan',
   'Added 2026-06-07 per Huayi. External gmail account allowed via auth.tsx allowlist + this table flips profiles.is_internal=true on first sign-in via the patched handle_new_user trigger.',
   'huayi@virgohome.io')
on conflict (email) do update set
  display_name = excluded.display_name,
  notes = excluded.notes,
  added_by = excluded.added_by;

-- Mirror into team_invite_list — the table that maps emails to canonical
-- display names. handle_new_user (below) reads this for the profile name
-- fallback.
insert into public.team_invite_list (email, display_name) values
  ('ryanyuan32@gmail.com', 'Ryan Yuan')
on conflict (email) do update set display_name = excluded.display_name;

-- ============================================================
-- 3. Patch handle_new_user.
--    Original (20260417015714_profiles.sql) inserted (id, display_name) only.
--    This rewrite adds an is_internal flag computed from:
--      a) email ends in @virgohome.io, OR
--      b) email is in external_email_allowlist.
--    Also preferentially uses team_invite_list display_name when present so
--    the operator's name renders consistently across the UI.
-- ============================================================
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name, is_internal)
  values (
    new.id,
    coalesce(
      (select display_name from public.team_invite_list where email = new.email),
      new.raw_user_meta_data->>'full_name',
      split_part(new.email, '@', 1)
    ),
    lower(new.email) like '%@virgohome.io'
      or exists (select 1 from public.external_email_allowlist where email = new.email)
  );
  return new;
end;
$$;

-- Existing trigger (on_auth_user_created on auth.users) still points at this
-- function — no trigger redefinition needed since CREATE OR REPLACE FUNCTION
-- preserves the binding.
