-- Security fix: close the self-privilege-escalation hole on public.profiles.
--
-- The original policy (20260417015714) was:
--   create policy "profiles_update_self" on public.profiles for update
--     to authenticated using (auth.uid() = id);
-- It has a USING clause but NO WITH CHECK. For UPDATE, Postgres falls back to
-- reusing USING as the check on the NEW row — so an authenticated user could
-- update *any* column on their own row, including `is_internal = true`, and
-- self-grant internal access (is_internal_user() gates every internal-only RLS
-- policy + edge function). `role` was equally writable.
--
-- The app never updates profiles from the client (both lib usages are SELECTs:
-- auth.tsx, activityLog.ts) — display_name is the only column a future
-- "edit my name" feature would touch. So we lock the client down to exactly
-- that, in two independent layers:
--
--  1. Column-level UPDATE privilege. `authenticated` may update only
--     display_name; is_internal / role / id / created_at are not in its column
--     ACL, so they cannot appear in a client UPDATE regardless of RLS. The
--     legitimate write paths are unaffected: handle_new_user() is SECURITY
--     DEFINER (runs as owner) and only INSERTs; backfills + manual grants run
--     as owner/service_role, which bypass this grant.
--
--  2. Explicit WITH CHECK on the RLS policy, so the row-ownership invariant is
--     also enforced on the new row (a user can't reassign id to another user).
--
-- Defense in depth: either layer alone closes the escalation; both together
-- survive a future re-grant or policy edit that loosens the other.

-- Layer 1 — column-level UPDATE privilege.
revoke update on public.profiles from authenticated;
grant update (display_name) on public.profiles to authenticated;

-- Layer 2 — replace the policy with one that has an explicit WITH CHECK.
drop policy if exists "profiles_update_self" on public.profiles;
create policy "profiles_update_self"
  on public.profiles for update
  to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);
