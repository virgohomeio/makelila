-- Security pass Phase 3a infra: a private secrets store for the cron
-- shared secret (and any future SQL-accessed secret). On Supabase
-- managed Postgres, `alter database ... set` requires superuser, and
-- Vault's create_secret() helper isn't exposed via SQL — so we use a
-- plain table in a private schema, locked down to the postgres role.
--
-- The PostgREST `db-schemas` config (Supabase Dashboard → Settings →
-- API) only exposes the schemas listed there (default: public). The
-- `private` schema is not exposed, so this table is invisible to anon
-- and authenticated REST clients.
--
-- Applied to prod via MCP before invoke_edge_function was patched to
-- read from it (see 20260604200100_cron_secret_header.sql). Secret
-- value is set manually via the SQL editor — never in git, never in
-- the migration files.

create schema if not exists private;

create table if not exists private.app_secrets (
  name text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

-- Belt-and-suspenders: enable RLS with no policies, explicitly revoke
-- default grants. Only the table owner (postgres) and SECURITY DEFINER
-- functions can read.
alter table private.app_secrets enable row level security;
revoke all on schema private from anon, authenticated, public;
revoke all on private.app_secrets from anon, authenticated, public;

-- SECURITY DEFINER reader. invoke_edge_function() calls this.
create or replace function private.get_app_secret(p_name text)
returns text
language sql
stable
security definer
set search_path = private, pg_temp
as $$
  select value from private.app_secrets where name = p_name;
$$;

revoke all on function private.get_app_secret(text) from anon, authenticated, public;
