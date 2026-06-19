-- Backfill the missing INSERT policy on public.orders.
--
-- The 20260604200000_rls_internal_only migration added SELECT + UPDATE for
-- 'orders' but never added an INSERT policy. With RLS on and no INSERT
-- policy, every operator-driven insert was silently denied with
-- "new row violates row-level security policy for table orders".
--
-- This bit the Service > Replacement Picker flow (createPendingReplacement
-- + createReplacementOrder in app/src/lib/orders.ts) — Shopify sync still
-- worked because the edge function uses the service role and bypasses RLS.
--
-- Mirrors the existing factory_orders_insert pattern from the same migration.

drop policy if exists "orders_insert" on public.orders;
create policy "orders_insert" on public.orders
  for insert to authenticated
  with check (public.is_internal_user());
