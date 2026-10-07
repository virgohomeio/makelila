-- Re-assert the profiles self-update lockdown. Production has drifted back to
-- the pre-fix state that 20260605140000 closed.
--
-- Observed on the operational project (txeftbbzeflequvrmjjr) on 2026-08-04:
--   - `authenticated` holds column-level UPDATE on EVERY profiles column —
--     id, created_at, display_name, email, is_internal, role, scheduling_url —
--     not just display_name. A blanket `grant update on public.profiles`
--     re-opens every column, which is what appears to have happened.
--   - "profiles_update_self" has polwithcheck = NULL, i.e. it is the original
--     20260417015714 policy, not the hardened one.
--
-- Both layers of the original fix are therefore missing, and the escalation it
-- closed is open again: any authenticated user can run
--   update profiles set role = 'finance', is_internal = true where id = auth.uid();
-- and self-grant the finance role (Finance module + QBO journals), manager
-- rights via is_manager() (refund approvals), and internal access via
-- is_internal_user() (most RLS policies in the app).
--
-- 20260804140000 does not fix this on its own: `grant update (scheduling_url)`
-- is additive, so on a table that already has blanket UPDATE it is a no-op.
--
-- Client write paths this must keep working — grep for `from('profiles')` with
-- an .update(): there is exactly one, lib/templates.ts's saveSchedulingUrl.
-- display_name is granted alongside it to preserve 20260605140000's stated
-- intent (a future "edit my name" feature) without re-opening anything else.
-- Both are re-granted below, so nothing in the app loses a write.
--
-- Idempotent: safe to run again if the ledger drifts a second time.

-- Layer 1 — column-level UPDATE privilege.
revoke update on public.profiles from authenticated;
grant update (display_name, scheduling_url) on public.profiles to authenticated;

-- Layer 2 — explicit WITH CHECK on the row-ownership invariant.
drop policy if exists "profiles_update_self" on public.profiles;
create policy "profiles_update_self"
  on public.profiles for update
  to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);
