-- Fix: use is_internal_user() helper for shipments and claims RLS policies,
-- consistent with the established pattern from 20260604200000_rls_internal_only.sql.

-- Fix shipments
drop policy if exists "internal only" on public.shipments;
create policy "internal only" on public.shipments
  using (public.is_internal_user())
  with check (public.is_internal_user());

-- Fix claims
drop policy if exists "internal only" on public.claims;
create policy "internal only" on public.claims
  using (public.is_internal_user())
  with check (public.is_internal_user());
