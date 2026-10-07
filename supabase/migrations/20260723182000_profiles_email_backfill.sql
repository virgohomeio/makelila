-- FR-9b fix: profiles had no email column, so executeRefund's lookup of the
-- Account Manager's address (via profiles.email) always failed and the
-- "refund executed → notify AM" email never sent. Add email and backfill from
-- auth.users for all current profiles. (Applied to prod via MCP.)
--
-- NOTE: no auth.users sync trigger is installed here (auth-schema triggers are
-- restricted). New profiles must have email populated by the provisioning flow;
-- all current internal users are covered by the backfill below.
alter table public.profiles add column if not exists email text;

update public.profiles p
   set email = u.email
  from auth.users u
 where u.id = p.id
   and p.email is distinct from u.email;
